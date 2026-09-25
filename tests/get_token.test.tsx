import { act, render, renderHook, waitFor } from "@testing-library/react";
import React, { useContext } from "react";
import { AuthContext, AuthProvider } from "../src";
import { AuthenticationRequiredError } from "../src/errors";
import type { TTokenResponse } from "../src/types";
import { AuthConsumer, authConfig } from "./test-utils";

const makeIdToken = (expiresIn: number, claims: Record<string, unknown> = {}) =>
  `eyJhbGciOiJSUzI1NiJ9.${btoa(JSON.stringify({ sub: "user", email_verified: true, exp: Math.floor(Date.now() / 1000) + expiresIn, ...claims }))}.signature`;

describe("silent token lifecycle", () => {
  const seedSession = (
    storage: Storage = localStorage,
    idExpiresIn = 600,
    accessExpiresIn = 600,
  ) => {
    storage.clear();
    const values = {
      token: "access-token",
      tokenExpire: Date.now() / 1000 + accessExpiresIn,
      idToken: makeIdToken(idExpiresIn),
      refreshToken: "refresh-token",
      refreshTokenExpire: Date.now() / 1000 + 3600,
    };
    Object.entries(values).forEach(([key, value]) =>
      storage.setItem(`ROCP_${key}`, JSON.stringify(value)),
    );
  };
  const renderAuth = (storage: "local" | "session" = "local") =>
    renderHook(() => useContext(AuthContext), {
      wrapper: ({ children }) => (
        <AuthProvider
          authConfig={{
            ...authConfig,
            autoLogin: false,
            storage,
            refreshTokenExpiryStrategy: "absolute",
          }}
        >
          {children}
        </AuthProvider>
      ),
    });
  const respondWith = (response: Partial<TTokenResponse> = {}) => {
    const refreshedIdToken = makeIdToken(900);
    jest.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        expires_in: 900,
        id_token: refreshedIdToken,
        ...response,
      }),
    } as Response);
    return refreshedIdToken;
  };

  beforeEach(() => {
    jest.mocked(fetch).mockReset();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: jest.fn(async (_name, callback) => callback()) },
    });
    seedSession();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test.each(["headers", "success body", "error body"])(
    "times out stalled %s, releases the token lock, and ignores late responses",
    async (phase) => {
      jest.useFakeTimers();
      seedSession(localStorage, -10);
      const previousSession = { ...localStorage };
      let releaseResponse!: () => void;
      const stalled = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let signal!: AbortSignal;
      jest.mocked(fetch).mockImplementationOnce(async (_url, options) => {
        signal = options!.signal!;
        if (phase === "headers") await stalled;
        return {
          ok: phase !== "error body",
          status: phase === "error body" ? 400 : 200,
          statusText: "Bad Request",
          json: async () => {
            if (phase === "success body") await stalled;
            return {
              access_token: "late-access-token",
              id_token: makeIdToken(900),
              refresh_token: "late-refresh-token",
            };
          },
          text: async () => {
            await stalled;
            return JSON.stringify({ error: "invalid_grant" });
          },
        } as Response;
      });
      const { result } = renderAuth();
      let settled = false;
      const pendingId = result.current.getIdTokenSilently();
      expect(result.current.getIdTokenSilently()).toBe(pendingId);
      const outcome = pendingId.catch((error: unknown) => {
        settled = true;
        return error;
      });
      const pendingAccess = result.current.getTokenSilently();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(29_999);
      });
      expect(settled).toBe(false);
      expect(signal.aborted).toBe(false);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });

      expect(await outcome).toMatchObject({ name: "TimeoutError" });
      expect(await outcome).not.toBeInstanceOf(AuthenticationRequiredError);
      expect(signal.aborted).toBe(true);
      await expect(pendingAccess).resolves.toBe("access-token");
      expect({ ...localStorage }).toEqual(previousSession);
      expect(result.current.isAuthenticated).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);

      await act(async () => {
        releaseResponse();
        await jest.advanceTimersByTimeAsync(0);
      });
      expect({ ...localStorage }).toEqual(previousSession);

      const refreshedIdToken = respondWith();
      await act(async () => {
        await expect(result.current.getIdTokenSilently()).resolves.toBe(
          refreshedIdToken,
        );
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test("bounds access-token refresh and releases the lock for a fresh ID token", async () => {
    jest.useFakeTimers();
    seedSession(localStorage, 600, -10);
    const idToken = JSON.parse(localStorage.getItem("ROCP_idToken")!);
    jest.mocked(fetch).mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () =>
            reject(new DOMException("Request aborted", "AbortError")),
          );
        }),
    );
    const { result } = renderAuth();
    const outcome = result.current.getTokenSilently().catch((error) => error);
    const pendingId = result.current.getIdTokenSilently();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(await outcome).toMatchObject({ name: "TimeoutError" });
    await expect(pendingId).resolves.toBe(idToken);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("clears the deadline after an immediate network failure", async () => {
    jest.useFakeTimers();
    seedSession(localStorage, -10);
    const failure = new TypeError("Network unavailable");
    jest.mocked(fetch).mockRejectedValueOnce(failure);
    const { result } = renderAuth();

    await expect(result.current.getIdTokenSilently()).rejects.toBe(failure);

    expect(jest.getTimerCount()).toBe(0);
    expect(localStorage.getItem("ROCP_refreshToken")).not.toBeNull();
  });

  test.each([
    [30, true],
    [31, false],
  ])(
    "refreshes at the expiry margin: %s seconds remaining, refresh=%s",
    async (expiresIn, shouldRefresh) => {
      jest.spyOn(Date, "now").mockReturnValue(1800000000000);
      seedSession(localStorage, expiresIn);
      const existingIdToken = JSON.parse(localStorage.getItem("ROCP_idToken")!);
      const refreshedIdToken = respondWith();
      const { result } = renderAuth();

      await act(async () => {
        await expect(result.current.getIdTokenSilently()).resolves.toBe(
          shouldRefresh ? refreshedIdToken : existingIdToken,
        );
      });
      expect(fetch).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
    },
  );

  test("requires authentication when no refresh token is available", async () => {
    seedSession(localStorage, -10);
    localStorage.removeItem("ROCP_refreshToken");
    const { result } = renderAuth();

    await expect(result.current.getIdTokenSilently()).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([null, "null", '"invalid-expiry"'])(
    "rejects missing or invalid refresh expiry metadata: %s",
    async (storedExpiry) => {
      seedSession(localStorage, -10);
      if (storedExpiry === null)
        localStorage.removeItem("ROCP_refreshTokenExpire");
      else localStorage.setItem("ROCP_refreshTokenExpire", storedExpiry);
      const { result } = renderAuth();

      await expect(result.current.getIdTokenSilently()).rejects.toBeInstanceOf(
        AuthenticationRequiredError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test("refreshes a three-part ID token with an undecodable payload", async () => {
    seedSession(localStorage, -10);
    localStorage.setItem(
      "ROCP_idToken",
      JSON.stringify("header.invalid.signature"),
    );
    const refreshedIdToken = respondWith();
    const { result } = renderAuth();

    await act(async () => {
      await expect(result.current.getIdTokenSilently()).resolves.toBe(
        refreshedIdToken,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([null, "", 123])(
    "does not store a refresh response with an invalid access token: %s",
    async (accessToken) => {
      seedSession(localStorage, -10);
      const previousIdToken = localStorage.getItem("ROCP_idToken");
      jest.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: accessToken,
          id_token: makeIdToken(900),
          refresh_token: "unusable-rotation",
        }),
      } as Response);
      const { result } = renderAuth();

      await expect(result.current.getIdTokenSilently()).rejects.toThrow(
        "Token response has no access token",
      );
      expect(localStorage.getItem("ROCP_idToken")).toBe(previousIdToken);
      expect(JSON.parse(localStorage.getItem("ROCP_token")!)).toBe(
        "access-token",
      );
      expect(JSON.parse(localStorage.getItem("ROCP_refreshToken")!)).toBe(
        "refresh-token",
      );
    },
  );

  test("retries after a transient server failure without clearing or caching a rejected session", async () => {
    seedSession(localStorage, -10);
    jest.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => JSON.stringify({ error: "temporarily_unavailable" }),
    } as Response);
    const refreshedIdToken = respondWith();
    const { result } = renderAuth();

    await expect(result.current.getIdTokenSilently()).rejects.toMatchObject({
      name: "FetchError",
      status: 503,
    });
    expect(JSON.parse(localStorage.getItem("ROCP_refreshToken")!)).toBe(
      "refresh-token",
    );
    await act(async () => {
      await expect(result.current.getIdTokenSilently()).resolves.toBe(
        refreshedIdToken,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("preserves the absolute refresh expiry when the refresh token rotates", async () => {
    seedSession(localStorage, -10);
    const previousExpiry = localStorage.getItem("ROCP_refreshTokenExpire");
    respondWith({
      refresh_token: "rotated-refresh-token",
      refresh_token_expires_in: 7200,
    });
    const { result } = renderAuth();

    await act(async () => {
      await result.current.getIdTokenSilently();
    });
    expect(JSON.parse(localStorage.getItem("ROCP_refreshToken")!)).toBe(
      "rotated-refresh-token",
    );
    expect(localStorage.getItem("ROCP_refreshTokenExpire")).toBe(
      previousExpiry,
    );
  });

  test("returns a fresh local-storage ID token without Web Locks", async () => {
    const existingIdToken = JSON.parse(localStorage.getItem("ROCP_idToken")!);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const { result } = renderAuth();

    await expect(result.current.getIdTokenSilently()).resolves.toBe(
      existingIdToken,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("refreshes a session-storage ID token without Web Locks", async () => {
    seedSession(sessionStorage, -10);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const refreshedIdToken = respondWith();
    const { result } = renderAuth("session");

    await act(async () => {
      await expect(result.current.getIdTokenSilently()).resolves.toBe(
        refreshedIdToken,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("returns a fresh raw ID token even when the access token has expired", async () => {
    seedSession(localStorage, 600, -10);
    const { result } = renderAuth();
    expect(result.current.idTokenData?.email_verified).toBe(true);
    await expect(result.current.getIdTokenSilently()).resolves.toBe(
      makeIdToken(600),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([-10, 20])(
    "refreshes an ID token expiring in %s seconds while the access token is fresh",
    async (expiresIn) => {
      seedSession(localStorage, expiresIn);
      const refreshedIdToken = respondWith();
      const { result } = renderAuth();
      await act(async () => {
        await expect(result.current.getIdTokenSilently()).resolves.toBe(
          refreshedIdToken,
        );
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.current.idToken).toBe(refreshedIdToken);
    },
  );

  test("shares one refresh between concurrent access and ID token requests across renders", async () => {
    seedSession(localStorage, -10, -10);
    const refreshedIdToken = respondWith({
      refresh_token: "rotated-refresh-token",
    });
    const { result, rerender } = renderAuth();
    const previous = result.current;
    rerender();
    await act(async () => {
      await expect(
        Promise.all([
          previous.getIdTokenSilently(),
          result.current.getTokenSilently(),
          result.current.getIdTokenSilently(),
        ]),
      ).resolves.toEqual([
        refreshedIdToken,
        "new-access-token",
        refreshedIdToken,
      ]);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("ROCP_refreshToken")!)).toBe(
      "rotated-refresh-token",
    );
  });

  test("preserves the refresh token and its absolute expiry when omitted from the response", async () => {
    seedSession(localStorage, -10);
    const expiry = localStorage.getItem("ROCP_refreshTokenExpire");
    respondWith();
    const { result } = renderAuth();
    await act(async () => {
      await result.current.getIdTokenSilently();
    });
    expect(JSON.parse(localStorage.getItem("ROCP_refreshToken")!)).toBe(
      "refresh-token",
    );
    expect(localStorage.getItem("ROCP_refreshTokenExpire")).toBe(expiry);
  });

  test.each([
    null,
    "invalid",
    makeIdToken(600, { exp: undefined }),
    makeIdToken(600, { exp: "9999999999" }),
  ])("refreshes missing or malformed cached ID tokens: %s", async (idToken) => {
    if (idToken === null) localStorage.removeItem("ROCP_idToken");
    else localStorage.setItem("ROCP_idToken", JSON.stringify(idToken));
    const refreshedIdToken = respondWith();
    const { result } = renderAuth();
    await act(async () => {
      await expect(result.current.getIdTokenSilently()).resolves.toBe(
        refreshedIdToken,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("preserves a still-valid ID token when access-token refresh omits it", async () => {
    seedSession(localStorage, 600, -10);
    const existingIdToken = JSON.parse(localStorage.getItem("ROCP_idToken")!);
    respondWith({ id_token: undefined });
    const { result } = renderAuth();
    await act(async () => {
      await expect(result.current.getTokenSilently()).resolves.toBe(
        "new-access-token",
      );
      await expect(result.current.getIdTokenSilently()).resolves.toBe(
        existingIdToken,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, "", "not-a-jwt", makeIdToken(-10), makeIdToken(10)])(
    "rejects refresh responses without a usable ID token: %s",
    async (idToken) => {
      seedSession(localStorage, -10);
      respondWith({ id_token: idToken });
      const { result } = renderAuth();
      await act(async () => {
        await expect(result.current.getIdTokenSilently()).rejects.toThrow(
          "No valid ID token",
        );
      });
    },
  );

  test("rejects expired refresh tokens without making a request", async () => {
    seedSession(localStorage, -10);
    localStorage.setItem(
      "ROCP_refreshTokenExpire",
      JSON.stringify(Date.now() / 1000 - 10),
    );
    const { result } = renderAuth();
    await expect(result.current.getIdTokenSilently()).rejects.toThrow(
      "Refresh token expired",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("propagates network failures without returning the expired ID token", async () => {
    seedSession(localStorage, -10);
    jest
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("Network unavailable"));
    const { result } = renderAuth();
    await expect(result.current.getIdTokenSilently()).rejects.toThrow(
      "Network unavailable",
    );
    expect(localStorage.getItem("ROCP_refreshToken")).not.toBeNull();
  });

  test("shares a failed refresh between concurrent ID-token requests", async () => {
    seedSession(localStorage, -10);
    jest
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError("Network unavailable"));
    const { result } = renderAuth();
    const outcomes = await Promise.allSettled([
      result.current.getIdTokenSilently(),
      result.current.getIdTokenSilently(),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("clears a revoked session and requires authentication", async () => {
    seedSession(localStorage, -10);
    jest.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    } as Response);
    const { result } = renderAuth();
    await act(async () => {
      await expect(result.current.getIdTokenSilently()).rejects.toBeInstanceOf(
        AuthenticationRequiredError,
      );
    });
    expect(localStorage.getItem("ROCP_refreshToken")).toBeNull();
    expect(result.current.idTokenData).toBeUndefined();
  });

  test("rechecks storage inside the cross-tab lock", async () => {
    seedSession(localStorage, -10);
    const refreshedIdToken = makeIdToken(900);
    jest
      .mocked(navigator.locks.request)
      .mockImplementationOnce(async (_name, callback: any) => {
        localStorage.setItem("ROCP_idToken", JSON.stringify(refreshedIdToken));
        return callback();
      });
    const { result } = renderAuth();
    await expect(result.current.getIdTokenSilently()).resolves.toBe(
      refreshedIdToken,
    );
    expect(navigator.locks.request).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("requires login instead of risking refresh rotation without cross-tab locks", async () => {
    seedSession(localStorage, -10);
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const { result } = renderAuth();
    await expect(result.current.getIdTokenSilently()).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("does not restore tokens when logout occurs during refresh", async () => {
    seedSession(localStorage, -10);
    let resolveRefresh!: (response: Response) => void;
    jest.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { result } = renderAuth();
    const tokenRequest = result.current.getIdTokenSilently();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => result.current.logOut());
    resolveRefresh({
      ok: true,
      json: async () => ({
        access_token: "late-access",
        id_token: makeIdToken(900),
      }),
    } as Response);
    await expect(tokenRequest).rejects.toThrow("Session changed");
    expect(localStorage.getItem("ROCP_token")).toBeNull();
    expect(localStorage.getItem("ROCP_idToken")).toBeNull();
  });

  test("updates ID-token claims using session storage", async () => {
    seedSession(sessionStorage, -10);
    const refreshedIdToken = respondWith();
    const { result } = renderAuth("session");
    await act(async () => {
      await result.current.getIdTokenSilently();
    });
    expect(result.current.idToken).toBe(refreshedIdToken);
    expect(result.current.idTokenData?.email_verified).toBe(true);
  });

  test("does not ask for login when an invalid_grant arrives after logout", async () => {
    seedSession(localStorage, -10);
    let resolveRefresh!: (response: Response) => void;
    jest.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { result } = renderAuth();
    const tokenRequest = result.current.getIdTokenSilently();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => result.current.logOut());
    resolveRefresh({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    } as Response);
    await expect(tokenRequest).rejects.toThrow("Session changed");
    expect(localStorage.getItem("ROCP_token")).toBeNull();
  });

  test("starts login only once for repeated calls", async () => {
    const { result } = renderAuth();
    const assign = jest.mocked(window.location.assign);
    assign.mockClear();
    await act(async () => {
      result.current.logIn();
      result.current.logIn();
    });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  });

  test("rejects new token requests during logout without requiring login", async () => {
    const { result } = renderAuth();
    act(() => result.current.logOut());
    await expect(result.current.getIdTokenSilently()).rejects.toThrow(
      "Authentication transition in progress",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

// @ts-ignore
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve<TTokenResponse>({
        scope: "value",
        refresh_token: "1234",
        token_type: "dummy",
        access_token:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.Sfl",
      }),
  }),
);

describe("make token request", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.mocked(fetch).mockReset();
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "access-token", expires_in: 600 }),
    } as Response);
    // Setting up a state similar to what it would be just after redirect back from auth provider
    localStorage.setItem("ROCP_loginInProgress", "true");
    localStorage.setItem("PKCE_code_verifier", "arandomstring");
    window.location.search = "?code=1234";
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("ends the callback loading state when token exchange times out", async () => {
    jest.useFakeTimers();
    jest.mocked(fetch).mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () =>
            reject(new DOMException("Request aborted", "AbortError")),
          );
        }),
    );
    const { result } = renderHook(() => useContext(AuthContext), {
      wrapper: ({ children }) => (
        <AuthProvider authConfig={authConfig}>{children}</AuthProvider>
      ),
    });
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBe(
      "Token request timed out after 30 seconds",
    );
    expect(localStorage.getItem("ROCP_token")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("does not exchange the code after state validation fails", async () => {
    localStorage.setItem("ROCP_auth_state", "expected-state");
    render(
      <AuthProvider authConfig={authConfig}>
        <AuthConsumer />
      </AuthProvider>,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem("ROCP_loginInProgress")).toBeNull();
  });

  test("with extra parameters", async () => {
    render(
      <AuthProvider authConfig={authConfig}>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("myTokenEndpoint", {
        body: "grant_type=authorization_code&code=1234&client_id=anotherClientId&redirect_uri=http%3A%2F%2Flocalhost%2F&code_verifier=arandomstring&testTokenKey=tokenValue",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test("with custom credentials", async () => {
    render(
      <AuthProvider
        authConfig={{ ...authConfig, tokenRequestCredentials: "include" }}
      >
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("myTokenEndpoint", {
        body: "grant_type=authorization_code&code=1234&client_id=anotherClientId&redirect_uri=http%3A%2F%2Flocalhost%2F&code_verifier=arandomstring&testTokenKey=tokenValue",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

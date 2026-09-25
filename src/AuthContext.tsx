import { Mutex } from "async-mutex";
import React, {
  createContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useBrowserStorage from "./Hooks";
import { createInternalConfig } from "./authConfig";
import {
  fetchTokens,
  fetchWithRefreshToken,
  redirectToLogin,
  redirectToLogout,
  validateState,
} from "./authentication";
import { decodeJWT } from "./decodeJWT";
import { AuthenticationRequiredError, FetchError } from "./errors";
import {
  FALLBACK_EXPIRE_TIME,
  epochAtSecondsFromNow,
  epochTimeIsPast,
  getRefreshExpiresIn,
} from "./timeUtils";
import type {
  IAuthContext,
  IAuthProvider,
  TInternalConfig,
  TPrimitiveRecord,
  TTokenData,
  TTokenResponse,
} from "./types";

const tokenMutex = new Mutex();
const tokenRequests = new Map<string, Promise<string>>();
const TOKEN_EXPIRY_MARGIN_SECONDS = 30;

export const AuthContext = createContext<IAuthContext>({
  token: undefined,
  login: () => null,
  logIn: () => null,
  logOut: () => null,
  error: null,
  isLoading: false,
  getTokenSilently: () => Promise.resolve(""),
  getIdTokenSilently: () =>
    Promise.reject(new Error("AuthProvider is required")),
  isAuthenticated: false,
});

export const AuthProvider = ({ authConfig, children }: IAuthProvider) => {
  const config: TInternalConfig = useMemo(
    () => createInternalConfig(authConfig),
    [authConfig],
  );
  const storage: Storage =
    config.storage === "session" ? sessionStorage : localStorage;

  const loginInProgressStorageKey = `${config.storageKeyPrefix}loginInProgress`;
  const logoutInProgressStorageKey = `${config.storageKeyPrefix}logoutInProgress`;
  const idTokenStorageKey = `${config.storageKeyPrefix}idToken`;
  const tokenStorageKey = `${config.storageKeyPrefix}token`;

  const [isLoading, setIsLoading] = useState<boolean>(
    () =>
      storage.getItem(loginInProgressStorageKey) === "true" ||
      storage.getItem(logoutInProgressStorageKey) === "true",
  );
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(
    () => storage.getItem(tokenStorageKey) !== null,
  );
  const [tokenData, setTokenData] = useState<TTokenData | undefined>(() => {
    try {
      const storedToken = storage.getItem(tokenStorageKey);
      const token = storedToken ? JSON.parse(storedToken) : undefined;
      if (token && config.decodeToken) {
        return decodeJWT(token);
      }
    } catch (e) {
      console.warn(`Failed to decode access token: ${(e as Error).message}`);
    }
  });
  const [idTokenData, setIdTokenData] = useState<TTokenData | undefined>(() => {
    try {
      const storedToken = storage.getItem(idTokenStorageKey);
      const idToken = storedToken ? JSON.parse(storedToken) : undefined;
      if (idToken) {
        return decodeJWT(idToken);
      }
    } catch (e) {
      console.warn(`Failed to decode id token: ${(e as Error).message}`);
    }
  });
  const [error, setError] = useState<string | null>(null);

  const [getRefreshToken, setRefreshToken] = useBrowserStorage<
    string | undefined
  >({
    key: `${config.storageKeyPrefix}refreshToken`,
    defaultValue: undefined,
    storage,
  });
  const [getRefreshTokenExpire, setRefreshTokenExpire] = useBrowserStorage<
    number | undefined
  >({
    key: `${config.storageKeyPrefix}refreshTokenExpire`,
    defaultValue: undefined,
    storage,
  });
  const [getTokenExpire, setTokenExpire] = useBrowserStorage<
    number | undefined
  >({
    key: `${config.storageKeyPrefix}tokenExpire`,
    defaultValue: undefined,
    storage,
  });
  const [getToken, setToken] = useBrowserStorage<string | undefined>({
    key: tokenStorageKey,
    defaultValue: undefined,
    storage,
    onChange: (token) => {
      setIsAuthenticated(!!token);

      try {
        if (token && config.decodeToken) {
          setTokenData(decodeJWT(token));
        } else {
          setTokenData(undefined);
        }
      } catch (e) {
        setTokenData(undefined);
        console.warn(`Failed to decode access token: ${(e as Error).message}`);
      }
    },
  });
  const [getIdToken, setIdToken] = useBrowserStorage<string | undefined>({
    key: idTokenStorageKey,
    defaultValue: undefined,
    storage,
    onChange: (idToken) => {
      try {
        if (idToken) {
          setIdTokenData(decodeJWT(idToken));
        } else {
          setIdTokenData(undefined);
        }
      } catch (e) {
        setIdTokenData(undefined);
        console.warn(`Failed to decode idToken: ${(e as Error).message}`);
      }
    },
  });
  const [getLoginMethod, setLoginMethod] = useBrowserStorage<
    "redirect" | "popup"
  >({
    key: `${config.storageKeyPrefix}loginMethod`,
    defaultValue: "redirect",
    storage,
  });
  const [getLoginInProgress, setLoginInProgress] = useBrowserStorage<
    boolean | undefined
  >({
    key: loginInProgressStorageKey,
    defaultValue: false,
    storage,
    onChange: (loginInProgress) => setIsLoading(loginInProgress === true),
  });
  const [getLogoutInProgress, setLogoutInProgress] = useBrowserStorage<
    boolean | undefined
  >({
    key: logoutInProgressStorageKey,
    defaultValue: false,
    storage,
    onChange: (logoutInProgress) => setIsLoading(logoutInProgress === true),
  });

  function clearStorage() {
    setRefreshToken(undefined);
    setToken(undefined);
    setTokenExpire(undefined);
    setRefreshTokenExpire(undefined);
    setIdToken(undefined);
    setTokenData(undefined);
    setIdTokenData(undefined);
    setLoginInProgress(undefined);
    setLogoutInProgress(undefined);
  }

  function logOut(
    state?: string,
    logoutHint?: string,
    additionalParameters?: TPrimitiveRecord,
  ) {
    const refreshToken = getRefreshToken();
    const token = getToken();
    const idToken = getIdToken();
    clearStorage();
    setLogoutInProgress(true);
    setError(null);
    if (config?.logoutEndpoint && token)
      redirectToLogout(
        config,
        token,
        refreshToken,
        idToken,
        state,
        logoutHint,
        additionalParameters,
      );
  }

  function logIn(
    state?: string,
    additionalParameters?: TPrimitiveRecord,
    method: "redirect" | "popup" = "redirect",
  ) {
    if (getLoginInProgress()) return;
    clearStorage();
    setLoginInProgress(true);
    setLoginMethod(method);
    // TODO: Raise error on wrong state type in v2
    let typeSafePassedState = state;
    if (state && typeof state !== "string") {
      const jsonState = JSON.stringify(state);
      console.warn(
        `Passed login state must be of type 'string'. Received '${jsonState}'. Ignoring value. In a future version, an error will be thrown here.`,
      );
      typeSafePassedState = undefined;
    }
    redirectToLogin(
      config,
      typeSafePassedState,
      additionalParameters,
      method,
    ).catch((error) => {
      console.error(error);
      setError(error.message);
      setLoginInProgress(false);
    });
  }

  function handleTokenResponse(response: TTokenResponse) {
    setToken(response.access_token);
    if (response.id_token) {
      setIdToken(response.id_token);
    }
    let tokenExp = FALLBACK_EXPIRE_TIME;
    // Decode IdToken, so we can use "exp" from that as fallback if expire not returned in the response
    try {
      if (response.id_token) {
        const decodedToken = decodeJWT(response.id_token);
        tokenExp = Math.round(Number(decodedToken.exp) - Date.now() / 1000); // number of seconds from now
      }
    } catch (e) {
      console.warn(`Failed to decode idToken: ${(e as Error).message}`);
    }
    const tokenExpiresIn =
      config.tokenExpiresIn ?? response.expires_in ?? tokenExp;
    setTokenExpire(epochAtSecondsFromNow(tokenExpiresIn));
    if (response.refresh_token) {
      setRefreshToken(response.refresh_token);
      const refreshTokenExpire = getRefreshTokenExpire();
      if (
        !refreshTokenExpire ||
        config.refreshTokenExpiryStrategy !== "absolute"
      ) {
        const refreshTokenExpiresIn =
          config.refreshTokenExpiresIn ??
          getRefreshExpiresIn(tokenExpiresIn, response);
        setRefreshTokenExpire(epochAtSecondsFromNow(refreshTokenExpiresIn));
      }
    }
  }

  async function refreshAccessToken(): Promise<string> {
    const refreshToken = getRefreshToken();
    if (!refreshToken)
      throw new AuthenticationRequiredError("No refresh token available");

    const refreshTokenExpire = getRefreshTokenExpire();
    if (
      typeof refreshTokenExpire !== "number" ||
      !Number.isFinite(refreshTokenExpire)
    ) {
      throw new AuthenticationRequiredError(
        "No refresh token expire available",
      );
    }

    // The refreshToken has expired
    if (epochTimeIsPast(refreshTokenExpire))
      throw new AuthenticationRequiredError("Refresh token expired");

    if (config.storage === "local" && !navigator.locks) {
      throw new AuthenticationRequiredError(
        "Cross-tab token refresh requires Web Locks",
      );
    }

    let result: TTokenResponse;
    try {
      result = await fetchWithRefreshToken({ config, refreshToken });
    } catch (error) {
      if (
        getRefreshToken() !== refreshToken ||
        getLoginInProgress() ||
        getLogoutInProgress()
      ) {
        throw new Error("Session changed during token refresh");
      }
      if (error instanceof FetchError && error.oauthError === "invalid_grant") {
        clearStorage();
        throw new AuthenticationRequiredError(
          "Refresh token is no longer valid",
        );
      }
      throw error;
    }
    if (
      getRefreshToken() !== refreshToken ||
      getLoginInProgress() ||
      getLogoutInProgress()
    ) {
      throw new Error("Session changed during token refresh");
    }
    if (typeof result.access_token !== "string" || !result.access_token) {
      throw new Error("Token response has no access token");
    }

    handleTokenResponse(result);
    return result.access_token;
  }

  function withTokenLock(
    kind: "access" | "id",
    operation: () => Promise<string>,
  ): Promise<string> {
    const lockName = `oauth2:${config.tokenEndpoint}:${config.clientId}:${config.storageKeyPrefix}`;
    const requestKey = `${config.storage}:${lockName}:${kind}`;
    const pending = tokenRequests.get(requestKey);
    if (pending) return pending;
    const runOperation = async () => {
      if (getLoginInProgress() || getLogoutInProgress()) {
        throw new Error("Authentication transition in progress");
      }
      return operation();
    };
    const request = tokenMutex.runExclusive(() => {
      if (
        config.storage === "local" &&
        typeof navigator !== "undefined" &&
        navigator.locks
      ) {
        return navigator.locks.request(lockName, runOperation);
      }
      return runOperation();
    });
    tokenRequests.set(requestKey, request);
    const clearRequest = () => {
      tokenRequests.delete(requestKey);
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }

  function tokenIsFresh(expiresAt: unknown): boolean {
    return (
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now() / 1000 + TOKEN_EXPIRY_MARGIN_SECONDS
    );
  }

  function getUsableIdToken(): string | undefined {
    const idToken = getIdToken();
    if (typeof idToken !== "string" || idToken.split(".").length !== 3)
      return undefined;
    try {
      return tokenIsFresh(decodeJWT(idToken).exp) ? idToken : undefined;
    } catch {
      return undefined;
    }
  }

  function getTokenSilently(): Promise<string> {
    return withTokenLock("access", async () => {
      const token = getToken();
      if (typeof token === "string" && token && tokenIsFresh(getTokenExpire()))
        return token;
      return refreshAccessToken();
    });
  }

  function getIdTokenSilently(): Promise<string> {
    return withTokenLock("id", async () => {
      const idToken = getUsableIdToken();
      if (idToken) return idToken;

      await refreshAccessToken();
      const refreshedIdToken = getUsableIdToken();
      if (!refreshedIdToken) {
        clearStorage();
        throw new AuthenticationRequiredError(
          "No valid ID token returned by token refresh",
        );
      }
      return refreshedIdToken;
    });
  }

  // This ref is used to make sure the 'fetchTokens' call is only made once.
  // Multiple calls with the same code will, and should, return an error from the API
  // See: https://beta.reactjs.org/learn/synchronizing-with-effects#how-to-handle-the-effect-firing-twice-in-development
  const didFetchTokens = useRef(false);

  // Runs once on page load
  useEffect(() => {
    // The client has been redirected back from the auth endpoint with an auth code
    const loginInProgress = getLoginInProgress();
    if (loginInProgress) {
      const urlParams = new URLSearchParams(window.location.search);
      if (!urlParams.get("code")) {
        // This should not happen. There should be a 'code' parameter in the url by now...
        const error_description =
          urlParams.get("error_description") ||
          "Bad authorization state. Refreshing the page and log in again might solve the issue.";
        console.error(
          `${error_description}\nExpected  to find a '?code=' parameter in the URL by now. Did the authentication get aborted or interrupted?`,
        );
        setError(error_description);
        clearStorage();
        return;
      }
      // Make sure we only try to use the auth code once
      if (!didFetchTokens.current) {
        didFetchTokens.current = true;
        try {
          validateState(urlParams, config.storage);
        } catch (e: unknown) {
          console.error(e);
          setError((e as Error).message);
          clearStorage();
          return;
        }
        // Request tokens from auth server with the auth code
        fetchTokens(config)
          .then((tokens: TTokenResponse) => {
            handleTokenResponse(tokens);
            // Call any postLogin function in authConfig
            if (config?.postLogin) config.postLogin();
            const loginMethod = getLoginMethod();
            if (loginMethod === "popup") window.close();
            setError(null);
          })
          .catch((error: Error) => {
            console.error(error);
            setError(error.message);
          })
          .finally(() => {
            if (config.clearURL) {
              // Clear ugly url params
              window.history.replaceState(
                null,
                "",
                `${window.location.pathname}${window.location.hash}`,
              );
            }
            setLoginInProgress(false);
          });
      }
      return;
    }

    // The client has been redirected back from the auth endpoint after a logout
    const logoutInProgress = getLogoutInProgress();
    if (logoutInProgress) {
      setLogoutInProgress(false);

      // Call any postLogout function in authConfig
      if (config?.postLogout) config.postLogout();
      return;
    }

    // First page visit
    const token = getToken();
    if (!token && config.autoLogin)
      return logIn(undefined, undefined, config.loginMethod);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        getTokenSilently,
        getIdTokenSilently,
        token: getToken(),
        idToken: getIdToken(),
        tokenData,
        idTokenData,
        login: logIn,
        loginInProgress: getLoginInProgress(),
        logIn,
        logOut,
        error,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export class AuthenticationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

export class FetchError extends Error {
  status: number;
  statusText: string;
  oauthError?: string;

  constructor(status: number, statusText: string, message: string) {
    super(message);
    this.name = "FetchError";
    this.status = status;
    this.statusText = statusText;
    try {
      const body = JSON.parse(message);
      if (typeof body?.error === "string") this.oauthError = body.error;
    } catch {
      this.oauthError = undefined;
    }
  }
}

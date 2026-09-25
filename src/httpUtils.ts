import { FetchError } from "./errors";
import type { TTokenRequest } from "./types";

function buildUrlEncodedRequest(request: TTokenRequest): string {
  let queryString = "";
  for (const [key, value] of Object.entries(request)) {
    queryString += `${queryString ? "&" : ""}${key}=${encodeURIComponent(value)}`;
  }
  return queryString;
}

interface PostWithXFormParams {
  url: string;
  request: TTokenRequest;
  credentials: RequestCredentials;
  signal?: AbortSignal;
}

export async function postWithXForm({
  url,
  request,
  credentials,
  signal,
}: PostWithXFormParams): Promise<Response> {
  return fetch(url, {
    method: "POST",
    body: buildUrlEncodedRequest(request),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    credentials: credentials,
    signal,
  }).then(async (response: Response) => {
    if (!response.ok) {
      const responseBody = await response.text();
      throw new FetchError(response.status, response.statusText, responseBody);
    }
    return response;
  });
}

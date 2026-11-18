// HTTP plug-in. The default uses the global fetch (Node >= 22 and browsers).

import { CallDeadline } from "./deadline.js";
import { TransportError } from "./errors.js";

export interface HttpResponse {
  status: number;
  /** Lowercase header name -> value. */
  headers: Record<string, string>;
  /** Every Set-Cookie line (Node only; browsers hide them). */
  setCookies: string[];
  body: string;
}

export interface HttpTransport {
  /** Never replay or follow redirects for POSTs. Honor cancellation and throw TransportError with `sent` when there is no answer. */
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HttpResponse>;
  get(url: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpResponse>;
}

// Errors where the request provably never left this process.
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_INVALID_URL",
]);

function causeCode(e: unknown): string | undefined {
  let c: unknown = e;
  for (let i = 0; i < 4 && c && typeof c === "object"; i++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string") return code;
    c = (c as { cause?: unknown }).cause;
  }
  return undefined;
}

export class FetchTransport implements HttpTransport {
  constructor(private readonly fetchFn: typeof fetch = (...a) => globalThis.fetch(...a)) {}

  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    return this.send(url, { method: "POST", body, headers }, timeoutMs, signal);
  }

  get(url: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpResponse> {
    return this.send(url, { method: "GET" }, timeoutMs, signal);
  }

  private async send(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const attempt = new CallDeadline(timeoutMs, signal ? [signal] : []);
    try {
      attempt.check();
      let resp: Response;
      try {
        resp = await this.fetchFn(url, {
          ...init,
          redirect: "manual",
          signal: attempt.signal,
        });
      } catch (e) {
        const name = (e as Error)?.name;
        if (name === "TimeoutError" || name === "AbortError")
          throw new TransportError(`no answer within ${timeoutMs}ms`, undefined, true, e);
        const code = causeCode(e);
        throw new TransportError(
          `request failed: ${code ?? (e as Error)?.message ?? e}`,
          undefined,
          !(code && NOT_SENT.has(code)),
          e,
        );
      }
      let text: string;
      try {
        text = await resp.text();
      } catch (e) {
        throw new TransportError(
          `reading the response failed: ${(e as Error)?.message ?? e}`,
          undefined,
          true,
          e,
        );
      }
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const setCookies =
        typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
      return { status: resp.status, headers, setCookies, body: text };
    } finally {
      attempt.close();
    }
  }
}

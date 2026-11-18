// API-key session.
//
// Login: POST {edge}/auth/api_key/login {"api_key": ...}
//   -> Set-Cookie: gravity=...; Expires=...
//   -> X-Grvt-Account-Id header, which gateways check as a sticky-session token
// Both go on every authenticated REST call and on the WS handshake. A WS connection keeps the
// session it was opened with, so the runtime re-logs in before expiry and moves sockets over.
// Node only: browsers neither expose Set-Cookie nor let code set Cookie headers.

import * as behavior from "../generated/behavior.js";
import { ApiError, ConfigError } from "./errors.js";
import type { HttpResponse, HttpTransport } from "./http.js";
import { logDebug } from "./log.js";

export const COOKIE_NAME = "gravity";
export const ACCOUNT_HEADER = "X-Grvt-Account-Id";
export const LOGIN_PATH = "/auth/api_key/login";
/** Used when the cookie carries no expiry. */
export const DEFAULT_TTL_S = behavior.SESSION_DEFAULT_LIFETIME_MS / 1000;
/** Re-login at this share of the cookie lifetime. */
export const REFRESH_AT = behavior.SESSION_RENEW_AT;
const LOGIN_RPC = "auth/api_key/login";

const nowS = () => Date.now() / 1000;
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

/** The current login. console.log, util.inspect and JSON.stringify show the cookie as `<redacted>`. */
export class Session {
  cookie: string | undefined;
  accountId: string | undefined;
  issuedAt = 0;
  expiresAt = 0;
  /** Bumps on every successful login. */
  generation = 0;
  fundingAccountAddress: string | undefined;
  #apiKey: string | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    apiKey: string | undefined,
    private readonly loginUrl: string,
    private readonly http: HttpTransport,
    private readonly attemptTimeoutMs = behavior.HTTP_ATTEMPT_TIMEOUT_MS,
    private readonly signal?: AbortSignal,
  ) {
    this.#apiKey = apiKey;
  }

  get enabled(): boolean {
    return this.#apiKey !== undefined;
  }

  /** What JSON.stringify and console.log show: everything but the cookie value. */
  toJSON(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      cookie: this.cookie === undefined ? undefined : "<redacted>",
      accountId: this.accountId,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      generation: this.generation,
      fundingAccountAddress: this.fundingAccountAddress,
    };
  }

  [inspectSymbol](): Record<string, unknown> {
    return this.toJSON();
  }

  /** Wall-clock seconds at which a re-login should happen. */
  get refreshDue(): number {
    return this.issuedAt + (this.expiresAt - this.issuedAt) * REFRESH_AT;
  }

  /** Cookie and account headers for an authenticated call (empty before login). */
  headers(): Record<string, string> {
    if (!this.cookie) return {};
    const h: Record<string, string> = { Cookie: `${COOKIE_NAME}=${this.cookie}` };
    if (this.accountId) h[ACCOUNT_HEADER] = this.accountId;
    return h;
  }

  private fresh(): boolean {
    return this.cookie !== undefined && nowS() < this.refreshDue;
  }

  /** Log in if there is no fresh session. Concurrent callers share one login. */
  async ensure(): Promise<void> {
    if (!this.enabled || this.fresh()) return;
    await this.login();
  }

  /** Log in now. Concurrent callers share one login. */
  login(): Promise<void> {
    this.inflight ??= this.doLogin().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async doLogin(): Promise<void> {
    const key = this.#apiKey;
    if (key === undefined)
      throw new ConfigError("this call needs a session: pass `apiKey` to the client");
    const resp = await this.http.post(
      this.loginUrl,
      JSON.stringify({ api_key: key }),
      { "Content-Type": "application/json" },
      this.attemptTimeoutMs,
      this.signal,
    );
    if (resp.status !== 200) {
      let msg = "login failed";
      try {
        msg = JSON.parse(resp.body)?.error ?? msg;
      } catch {
        // not JSON
      }
      // 401/403 are permanent until the user fixes the key; reconnect loops stop on these.
      throw new ApiError(1000, msg, resp.status, LOGIN_RPC, resp.status >= 500);
    }
    const { cookie, expires } = parseCookie(resp);
    if (!cookie)
      throw new ApiError(
        1000,
        "login response had no gravity cookie (in a browser, Set-Cookie is not readable)",
        resp.status,
        LOGIN_RPC,
        false,
      );
    let funding: string | undefined;
    try {
      funding = JSON.parse(resp.body)?.funding_account_address;
    } catch {
      // not JSON
    }
    const t = nowS();
    this.cookie = cookie;
    this.accountId = resp.headers[ACCOUNT_HEADER.toLowerCase()];
    this.issuedAt = t;
    this.expiresAt = expires !== undefined && expires > t ? expires : t + DEFAULT_TTL_S;
    this.generation++;
    this.fundingAccountAddress = funding;
    logDebug(
      `logged in, session generation ${this.generation} valid for ${Math.round(this.expiresAt - t)}s`,
    );
  }
}

/** The gravity cookie value and its expiry (wall-clock seconds) from Set-Cookie lines. */
export function parseCookie(resp: Pick<HttpResponse, "setCookies">): {
  cookie?: string;
  expires?: number;
} {
  for (const line of resp.setCookies) {
    const [first, ...attrs] = line.split(";").map((s) => s.trim());
    if (!first?.startsWith(`${COOKIE_NAME}=`)) continue;
    let expires: number | undefined;
    for (const a of attrs) {
      const i = a.indexOf("=");
      const k = (i < 0 ? a : a.slice(0, i)).toLowerCase();
      const v = i < 0 ? "" : a.slice(i + 1).trim();
      if (k === "max-age" && v !== "" && !Number.isNaN(Number(v))) {
        expires = nowS() + Number(v);
        break;
      }
      if (k === "expires" && expires === undefined) {
        const ms = Date.parse(v);
        if (!Number.isNaN(ms)) expires = ms / 1000;
      }
    }
    return { cookie: first.slice(COOKIE_NAME.length + 1), expires };
  }
  return {};
}

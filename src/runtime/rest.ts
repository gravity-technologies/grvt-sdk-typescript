// REST calls: POST {gateway}{path} with a JSON body.
//
// Success: HTTP 200, the body is the RPC's response.
// Failure: body {"code": int, "message": str, "status": int} (lite: {"c", "m", "s"}, renamed by errorBody).
// Reads retry with full jitter on retryable failures; writes are sent exactly once.

import * as behavior from "../generated/behavior.js";
import type { CallDeadline } from "./deadline.js";
import {
  ApiError,
  type ClientOrderIds,
  ErrorTable,
  OrderStateUnknown,
  TransportError,
  isRetryable,
} from "./errors.js";
import type { Hooks } from "./hooks.js";
import type { HttpTransport } from "./http.js";
import { debugEnabled, logDebug, redact, redactHeader } from "./log.js";
import { Backoff } from "./protocol.js";
import type { RpcSpec } from "./spec.js";

export interface RestCall {
  http: HttpTransport;
  url: string;
  spec: RpcSpec;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  deadline: CallDeadline;
  hooks: Hooks;
  errors: ErrorTable;
  clientOrderId: ClientOrderIds;
  sleep: (ms: number) => Promise<void>;
  /** Renames a parsed error body to full names (lite encoding). */
  errorBody?: (body: unknown) => unknown;
}

/** The backoff between read retries. */
export function readBackoff(): Backoff {
  return new Backoff(behavior.READ_BACKOFF_BASE_MS, behavior.READ_BACKOFF_CAP_MS);
}

/** Returns the 200 body text. */
export async function restCall(c: RestCall): Promise<string> {
  const backoff = readBackoff();
  for (let attempt = 1; ; attempt++) {
    c.deadline.check();
    let err: unknown;
    try {
      return await once(c);
    } catch (e) {
      err = e;
    }
    if (c.spec.write) {
      if (err instanceof TransportError && err.sent)
        throw new OrderStateUnknown(c.spec.method, err.message, c.clientOrderId, err);
      if (err instanceof ApiError && c.errors.uncertain(err))
        throw new OrderStateUnknown(c.spec.method, err.message, c.clientOrderId, err);
      throw err;
    }
    if (c.deadline.signal.aborted) throw c.deadline.signal.reason;
    if (!behavior.retryRead(isRetryable(err), attempt)) throw err;
    const delayMs = backoff.nextDelayMs();
    c.hooks.emit(() => ({
      type: "retry",
      rpc: c.spec.method,
      attempt,
      delayMs,
      error: String((err as Error)?.message ?? err),
    }));
    await c.deadline.wait(c.sleep(delayMs));
  }
}

async function once(c: RestCall): Promise<string> {
  if (debugEnabled()) {
    const h = Object.entries(c.headers).map(([k, v]) => `${k}: ${redactHeader(k, v)}`);
    logDebug(`POST ${c.url} headers=${JSON.stringify(h)} body=${redact(c.body)}`);
  }
  c.deadline.check();
  let resp;
  try {
    resp = await c.deadline.wait(
      c.http.post(c.url, c.body, c.headers, c.timeoutMs, c.deadline.signal),
    );
  } catch (e) {
    if (c.deadline.signal.aborted)
      throw new TransportError(
        "call cancelled while awaiting its response",
        c.spec.method,
        true,
        c.deadline.signal.reason,
      );
    if (e instanceof TransportError) throw new TransportError(e.message, c.spec.method, e.sent, e);
    throw e;
  }
  if (debugEnabled()) logDebug(`${c.spec.method} -> ${resp.status} ${redact(resp.body)}`);
  if (resp.status === 200) return resp.body;
  let body: unknown;
  try {
    body = JSON.parse(resp.body);
  } catch {
    /* malformed error reply */
  }
  throw c.errors.responseError(c.errorBody ? c.errorBody(body) : body, resp.status, c.spec.method);
}

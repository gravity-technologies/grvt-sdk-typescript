// The runtime's shared defaults and rules equal sdk/contract/behavior.json (src/generated/behavior.ts).
// A failure here means the runtime holds its own copy of a shared constant: use the generated one instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as behavior from "../src/generated/behavior.js";
import { ERRORS } from "../src/generated/errors.js";
import {
  ApiError,
  Backoff,
  ErrorTable,
  Grvt,
  RateLimitError,
  TimeCounterClientOrderId,
} from "../src/index.js";
import { DEFAULT_TTL_S, REFRESH_AT } from "../src/runtime/auth.js";
import { readBackoff } from "../src/runtime/rest.js";
import { FakeHttp } from "./fakes.js";

describe("shared behavior", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the shared client defaults", () => {
    const rt = new Grvt({ env: "testnet", http: new FakeHttp() }).runtime;
    const internals = rt as unknown as {
      callTimeoutMs: number;
      httpAttemptTimeoutMs: number;
      queueSize: number;
      sessionRetryDelayMs: number;
    };
    expect(internals.callTimeoutMs).toBe(behavior.CALL_TIMEOUT_MS);
    expect(internals.httpAttemptTimeoutMs).toBe(behavior.HTTP_ATTEMPT_TIMEOUT_MS);
    expect(internals.queueSize).toBe(behavior.QUEUE_SIZE);
    expect(internals.sessionRetryDelayMs).toBe(behavior.SESSION_RETRY_DELAY_MS);
    expect((rt.session as unknown as { attemptTimeoutMs: number }).attemptTimeoutMs).toBe(
      behavior.HTTP_ATTEMPT_TIMEOUT_MS,
    );
    const read = readBackoff();
    expect([read.baseMs, read.capMs]).toEqual([
      behavior.READ_BACKOFF_BASE_MS,
      behavior.READ_BACKOFF_CAP_MS,
    ]);
    for (const socket of [rt.md, rt.td]) {
      expect(socket.opts.requestTimeoutMs).toBe(behavior.WS_REQUEST_TIMEOUT_MS);
      expect(socket.opts.resyncTimeoutMs).toBe(behavior.RESYNC_TIMEOUT_MS);
    }
    const backoff = new Backoff();
    expect([backoff.baseMs, backoff.capMs]).toEqual([
      behavior.RECONNECT_BACKOFF_BASE_MS,
      behavior.RECONNECT_BACKOFF_CAP_MS,
    ]);
    expect(REFRESH_AT).toBe(behavior.SESSION_RENEW_AT);
    expect(DEFAULT_TTL_S * 1000).toBe(behavior.SESSION_DEFAULT_LIFETIME_MS);
  });

  it("lays out client order ids", () => {
    const seconds = 1_700_000_000;
    vi.spyOn(Date, "now").mockReturnValue(seconds * 1000);
    const ids = new TimeCounterClientOrderId();
    const [a, b] = [BigInt(ids.nextId()), BigInt(ids.nextId())];
    for (const n of [a, b]) {
      expect(n >> 63n).toBe(1n);
      expect(
        (n >> BigInt(behavior.CLIENT_ORDER_ID_COUNTER_BITS)) &
          behavior.CLIENT_ORDER_ID_SECONDS_MASK,
      ).toBe(BigInt(seconds));
    }
    const mask = behavior.CLIENT_ORDER_ID_COUNTER_MASK;
    expect(b & mask).toBe((a + 1n) & mask);
  });

  it("classifies errors by the shared rule", () => {
    const table = new ErrorTable(ERRORS);
    expect(table.apiError(behavior.RATE_LIMIT_CODE, "x", 429, "x")).toBeInstanceOf(RateLimitError);
    for (const status of behavior.READ_RETRY_STATUSES)
      expect(table.retryable(99999, status)).toBe(true);
    expect(table.retryable(99999, 500)).toBe(false);
    const known = 1003; // a contract code with HTTP status 400
    const low = behavior.WRITE_REJECTED_STATUS_MIN;
    const high = behavior.WRITE_REJECTED_STATUS_MAX;
    const uncertain = (status: number) =>
      table.uncertain(table.apiError(known, "x", status, "x") as ApiError);
    expect([uncertain(low), uncertain(high)]).toEqual([false, false]);
    expect([uncertain(low - 1), uncertain(high + 1)]).toEqual([true, true]);
  });
});

// The runtime's shared defaults and rules equal sdk/contract/behavior.json (src/generated/behavior.ts).
// A failure here means the runtime holds its own copy of a shared constant: use the generated one instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as behavior from "../src/generated/behavior.js";
import { ERRORS } from "../src/generated/errors.js";
import * as sdk from "../src/index.js";
import {
  ApiError,
  Backoff,
  ConfigError,
  ErrorTable,
  type Event,
  type EventKind,
  Grvt,
  RateLimitError,
  TimeCounterClientOrderId,
} from "../src/index.js";
import { DEFAULT_TTL_S, REFRESH_AT } from "../src/runtime/auth.js";
import { readBackoff } from "../src/runtime/rest.js";
import { FakeHttp } from "./fakes.js";
import { loadShared } from "./shared.js";

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
      expect(socket.opts.idleTimeoutMs).toBe(behavior.WS_IDLE_TIMEOUT_MS);
    }
    const backoff = new Backoff();
    expect([backoff.baseMs, backoff.capMs]).toEqual([
      behavior.RECONNECT_BACKOFF_BASE_MS,
      behavior.RECONNECT_BACKOFF_CAP_MS,
    ]);
    expect(REFRESH_AT).toBe(behavior.SESSION_RENEW_AT);
    expect(DEFAULT_TTL_S * 1000).toBe(behavior.SESSION_DEFAULT_LIFETIME_MS);
  });

  it("shares the default order ID provider across clients", async () => {
    const a = new Grvt();
    const b = new Grvt();
    const custom = { nextId: () => "42" };
    const c = new Grvt({ clientOrderIds: custom });
    try {
      expect(a.runtime.clientOrderIds).toBe(b.runtime.clientOrderIds);
      expect(c.runtime.clientOrderIds).toBe(custom);
    } finally {
      await Promise.all([a.close(), b.close(), c.close()]);
    }
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

// -- options and errors: the "options" and "errors" tables of behavior.json --------------------------------

interface SharedOption {
  name: string;
  default: string;
  min?: number;
}
interface SharedError {
  kind: string;
  parent?: string;
  fields: string[];
  names: Record<string, string>;
  renamed?: Record<string, Record<string, string>>;
}
interface SharedEvent {
  kind: string;
  fields: string[];
  renamed?: Record<string, Record<string, string>>;
}
const shared = loadShared("contract/behavior.json") as {
  constants: Record<string, { unit: string }>;
  options: SharedOption[];
  errors: SharedError[];
  events: SharedEvent[];
};
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("shared options", () => {
  for (const o of shared.options) {
    // A duration is in milliseconds, with Ms on its name.
    const ms = shared.constants[o.default]!.unit === "ms";
    const key = camel(o.name) + (ms ? "Ms" : "");
    it(`${key} rejects a value below its minimum when the client is built`, () => {
      const client = (value: number) =>
        new Grvt({ env: "testnet", http: new FakeHttp(), [key]: value });
      expect(() => client(o.min === undefined ? 0 : o.min - 1)).toThrow(ConfigError);
      expect(() => client(o.min ?? 1)).not.toThrow();
    });
  }
});

// One instance of each kind, to check the fields it carries.
const samples: Record<string, () => Error> = {
  api: () => new sdk.ApiError(1003, "bad", 400, "v1/x", false),
  rate_limit: () => new sdk.RateLimitError("slow", 429, "v1/x"),
  transport: () => new sdk.TransportError("down", "v1/x", true),
  order_state_unknown: () => new sdk.OrderStateUnknown("v1/x", "timeout", "1"),
  order_out_of_bounds: () =>
    new sdk.OrderOutOfBounds("m", {
      instrument: "I",
      leg: 0,
      field: "size",
      check: "at_least",
      limit: "min_size",
      value: "0",
      limitValue: "1",
      nearest: ["1"],
      serverCode: 2000,
    }),
  stream_overflow: () => new sdk.StreamOverflow("v1.ticker.d", "I@500", 1),
  frame_too_large: () => new sdk.FrameTooLarge(2, 1),
  decode: () => new sdk.DecodeError("v1/x", "bad"),
  signing: () => new sdk.SigningError("bad"),
  config: () => new sdk.ConfigError("bad"),
  closed: () => new sdk.ClosedError(),
  pagination_cycle: () => new sdk.PaginationCycle("c"),
  book: () => new sdk.BookError("not_ready"),
};

describe("shared errors", () => {
  const exports = sdk as unknown as Record<string, unknown>;
  const cls = (name: string) => exports[name] as abstract new (...args: never[]) => Error;

  it("exports exactly the shared kinds", () => {
    const exported = Object.keys(exports).filter((n) => {
      const v = exports[n];
      return typeof v === "function" && v.prototype instanceof Error;
    });
    // DecimalError is TypeScript's extra (behavior.json, errors.signing.extras).
    const want = [...shared.errors.map((e) => e.names.typescript!), "GrvtError", "DecimalError"];
    expect(exported.sort()).toEqual(want.sort());
    expect(Object.keys(samples).sort()).toEqual(shared.errors.map((e) => e.kind).sort());
  });

  for (const e of shared.errors) {
    it(`${e.names.typescript} has the shared parent and fields`, () => {
      const parent = e.parent
        ? shared.errors.find((p) => p.kind === e.parent)!.names.typescript!
        : "GrvtError";
      expect(Object.getPrototypeOf(cls(e.names.typescript!))).toBe(cls(parent));
      const err = samples[e.kind]!();
      expect(err).toBeInstanceOf(cls(e.names.typescript!));
      const renamed = e.renamed?.typescript ?? {};
      for (const f of e.fields) expect(err).toHaveProperty(renamed[f] ?? camel(f));
    });
  }
});

// -- events: the "events" table of behavior.json ------------------------------------------------------------

// One event of each kind with every field set. Required<> and the object literal let the compiler hold each
// sample to the real type: a missing field or one the type lacks fails the typecheck, so the keys below are
// the type's fields.
const gap = { reason: "disconnect" } as const;
const eventSamples: { [K in EventKind]: Required<Extract<Event, { type: K }>> } = {
  connect: { type: "connect", socket: "md" },
  reconnect: { type: "reconnect", socket: "md" },
  disconnect: { type: "disconnect", socket: "md", code: 1000, reason: "closed" },
  subscribe: {
    type: "subscribe",
    socket: "md",
    stream: "v1.ticker.d",
    selector: "X@500",
    latestSequenceNumber: "1",
    numSnapshots: 1,
  },
  gap: {
    type: "gap",
    gap,
    socket: "md",
    stream: "v1.ticker.d",
    selector: "X@500",
    expectedPrev: "1",
    prev: "2",
    seq: "3",
  },
  retry: { type: "retry", socket: "md", rpc: "v1/x", attempt: 1, delayMs: 1, error: "x" },
  frame: { type: "frame", socket: "md", direction: "in", raw: "{}" },
  session_rotated: {
    type: "session_rotated",
    generation: 1,
    expiresAt: new Date(0),
    websocketReconnectRequired: true,
  },
  error: { type: "error", socket: "md", fatal: false, error: "x" },
};

describe("shared events", () => {
  it("has exactly the shared kinds", () => {
    expect(Object.keys(eventSamples).sort()).toEqual(shared.events.map((e) => e.kind).sort());
  });

  for (const e of shared.events) {
    it(`${e.kind} has the shared fields`, () => {
      const renamed = e.renamed?.typescript ?? {};
      const sample = eventSamples[e.kind as EventKind];
      const fields = Object.keys(sample).filter((k) => k !== "type");
      expect(fields.sort()).toEqual(e.fields.map((f) => renamed[f] ?? camel(f)).sort());
    });
  }
});

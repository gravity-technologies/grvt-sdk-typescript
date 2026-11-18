// Replays sdk/scenarios/runtime.json, the runtime scenarios every SDK shares, against the fakes.
// The format is described in sdk/scenarios/README.md. Calls and streams run in both wire encodings; in
// lite the fakes also fail the scenario on any key the client sent that is not a lite name.
/* eslint-disable vitest/no-conditional-expect, vitest/valid-title, vitest/expect-expect -- assertions live in runCall and runStream */
import { loadShared } from "./shared.js";
import { afterEach, expect, it } from "vitest";
import { Decimal } from "../src/runtime/scalars.js";
import {
  ApiError,
  backfillPages,
  DecodeError,
  type Event,
  type GapRange,
  Grvt,
  type models as m,
  OrderStateUnknown,
  pages,
  PaginationCycle,
  PrivateKeySigner,
  RateLimitError,
  refreshCancelCountdown,
  StreamOverflow,
  type Subscription,
  TransportError,
} from "../src/index.js";
import {
  FakeGateway,
  FakeHttp,
  type HttpReply,
  notSent,
  sentNoAnswer,
  take,
  waitUntil,
} from "./fakes.js";

interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  error?: unknown;
  refuse?: boolean;
  drop?: boolean;
  hang?: boolean;
  send_fails?: boolean;
  next?: string;
  fail?: boolean;
}
interface Gap {
  reason: string;
  after: number | null;
  through: number | null;
  frame?: [number, number];
}
interface Scenario {
  name: string;
  call: {
    kind: "read" | "write" | "countdown" | "stream" | "pages" | "backfill";
    transport?: "ws";
    stream?: string;
    client_order_id?: string;
    seconds?: number;
    ws_request_timeout_ms?: number;
    resync_timeout_ms?: number;
    instruments?: string[];
    queue_size?: number;
    cookie_max_age_s?: number;
    take?: number;
    gap?: Gap;
  };
  replies?: Reply[];
  steps?: {
    push?: [number, number];
    feed?: { value: unknown };
    drop?: boolean;
    ignore_subscribes?: number;
    ack_latest?: number;
    wait_acks?: number;
    wait_reconnects?: number;
    wait_dropped?: number;
  }[];
  expect: {
    outcome?: string;
    code?: number;
    status?: number | null;
    retryable?: boolean;
    rpc?: string;
    sent?: boolean;
    attempts?: number;
    retries?: number;
    client_order_ids?: string[];
    sent_client_order_id?: string;
    items?: (number | string)[];
    gaps?: Gap[];
    other_subscriptions?: { items: (number | string)[]; gaps: Gap[] }[];
    overflow_capacity?: number;
    subscribes?: number;
    unsubscribes?: number;
    subscribe_request?: unknown;
    logins?: number;
    relogin_after_ms?: [number, number];
    session_rotated?: number[];
    handshake_logins?: number[];
    pages?: number;
    cursors?: (string | null)[];
    cursor?: string;
    history_exhausted?: boolean[];
    continuity?: string;
  };
  skip?: Record<string, string>;
}

const behavior = loadShared("contract/behavior.json") as Record<string, { value: unknown }>;

/** Replaces every "$key", "$key.index", "$key*n" and "$key+n" string with the value from behavior.json. */
function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, resolve(e)]));
  const ref =
    typeof v === "string" ? /^\$([a-z_]+)(?:\.(\d+))?(?:\*(\d+))?([+-]\d+)?$/.exec(v) : null;
  if (!ref) return v;
  const entry = behavior[ref[1]!];
  if (!entry) throw new Error(`unknown behavior key ${ref[1]}`);
  let value = entry.value;
  if (ref[2] !== undefined) value = (value as unknown[])[Number(ref[2])];
  if (ref[3] !== undefined) value = (value as number) * Number(ref[3]);
  if (ref[4] !== undefined) value = (value as number) + Number(ref[4]);
  return value;
}

const scenarios = resolve(loadShared("scenarios/runtime.json")) as Scenario[];
const KEY = "0xbfe25ff07bd38cb3fbc28a2a296d41aabd68a78c929d257935906489fc9c6d89";
const clients: Grvt[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const order = (clientOrderId?: string): m.OrderInput => ({
  sub_account_id: "8289849667772468",
  time_in_force: "GOOD_TILL_TIME",
  legs: [
    {
      instrument: "BTC_USDT_Perp",
      size: new Decimal("0.01"),
      limit_price: new Decimal("65000.1"),
      is_buying_asset: true,
    },
  ],
  ...(clientOrderId === undefined ? {} : { metadata: { client_order_id: clientOrderId } }),
});

const httpReply = (r: Reply): HttpReply => {
  if (r.refuse) return notSent();
  if (r.drop) return sentNoAnswer();
  return { status: r.status, body: r.raw ?? JSON.stringify(r.body) };
};

function outcome(err: unknown): string {
  if (err === undefined) return "ok";
  if (err instanceof OrderStateUnknown) return "order_state_unknown";
  if (err instanceof DecodeError) return "decode_error";
  if (err instanceof RateLimitError) return "rate_limited";
  if (err instanceof ApiError) return "api_error";
  if (err instanceof TransportError) return "transport_error";
  if (err instanceof RangeError) return "validation_error";
  return `unexpected ${String(err)}`;
}

async function runCall(sc: Scenario, lite: boolean): Promise<void> {
  const gw = new FakeGateway({ lite });
  const http = new FakeHttp({ lite });
  const ws = sc.call.transport === "ws";
  const events: Event[] = [];
  const c = new Grvt({
    env: gw.env(),
    webSocket: gw.factory,
    http,
    onEvent: (e) => events.push(e),
    apiKey: "k",
    signer: new PrivateKeySigner(KEY),
    encoding: lite ? "lite" : "full",
    ...(ws ? { orderTransport: "ws" as const } : {}),
    ...(sc.call.ws_request_timeout_ms ? { wsRequestTimeoutMs: sc.call.ws_request_timeout_ms } : {}),
  });
  clients.push(c);
  c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
    instrument_hash: "0x030501",
    base_decimals: 9,
  });
  const replies = sc.replies ?? [];
  const path = {
    read: "/full/v1/ticker",
    write: "/full/v1/create_order",
    countdown: "/full/v1/cancel_on_disconnect",
  }[sc.call.kind as "read"];
  if (!ws && replies.length) http.on(path, ...replies.map(httpReply));

  const reply = replies[0];
  if (ws) {
    gw.ignoreRpcs.add("v1/create_order");
    if (reply?.refuse || reply?.send_fails) {
      // Open the socket with a read first, then break it the way the reply says.
      await c.runtime.td.request("v1/instrument", "{}", false);
      const conn = gw.open()[0]!;
      const send = conn.send.bind(conn);
      if (reply.refuse) conn.readyState = 2; // closing: nothing can be written
      else
        conn.send = (data) => {
          send(data); // the frame reaches the gateway, then the connection resets
          throw new Error("connection reset mid-frame");
        };
    }
  }

  let call: Promise<unknown>;
  if (sc.call.kind === "read") call = c.ticker({ instrument: "BTC_USDT_Perp" });
  else if (sc.call.kind === "countdown") call = refreshCancelCountdown(c, "123", sc.call.seconds!);
  else call = c.createOrder({ order: order(sc.call.client_order_id) });
  const settled = call.then(
    () => undefined,
    (e: unknown) => e,
  );

  if (ws && reply && !reply.refuse && !reply.send_fails) {
    await waitUntil("write sent", () => gw.rpcs("v1/create_order").length === 1);
    const request = gw.rpcs("v1/create_order")[0];
    if (reply.drop) gw.dropAll();
    else if (reply.error !== undefined)
      gw.open()[0]!.deliver({ id: request.id, error: reply.error });
  }
  const err = await settled;

  const want = sc.expect;
  expect(outcome(err)).toBe(want.outcome);
  if (want.outcome === "api_error") expect((err as ApiError).code).toBe(want.code);
  if (want.retryable !== undefined) expect((err as ApiError).retryable).toBe(want.retryable);
  if (want.status !== undefined) expect((err as ApiError).status ?? null).toBe(want.status);
  if (want.rpc !== undefined) expect((err as OrderStateUnknown).rpc).toBe(want.rpc);
  if (want.retries !== undefined)
    expect(events.filter((e) => e.type === "retry")).toHaveLength(want.retries);
  if (want.outcome === "transport_error" && want.sent !== undefined)
    expect((err as TransportError).sent).toBe(want.sent);
  if (want.outcome === "order_state_unknown" && want.client_order_ids)
    expect([...(err as OrderStateUnknown).clientOrderIds]).toEqual(want.client_order_ids);
  const sent = ws
    ? gw.rpcs("v1/create_order").map((r) => r.params)
    : http.callsTo(path).map((r) => JSON.parse(r.body || "{}"));
  if (want.attempts !== undefined) expect(sent).toHaveLength(want.attempts);
  if (want.outcome === "order_state_unknown")
    expect([...(err as OrderStateUnknown).clientOrderIds]).toEqual([
      sent.at(-1).order.metadata.client_order_id,
    ]);
  if (want.sent_client_order_id === "generated") {
    const id = BigInt(sent[0].order.metadata.client_order_id);
    expect(id >= 1n << 63n && id < 1n << 64n).toBe(true);
  } else if (want.sent_client_order_id !== undefined) {
    expect(sent[0].order.metadata.client_order_id).toBe(want.sent_client_order_id);
  }
  expect([...gw.violations, ...http.violations]).toEqual([]);
}

async function runStream(sc: Scenario, lite: boolean): Promise<void> {
  const gw = new FakeGateway({ lite });
  const stream = sc.call.stream!;
  gw.latest.set(stream, "100");
  const http = new FakeHttp();
  if (sc.call.cookie_max_age_s)
    http.on(
      "/auth/api_key/login",
      ...[`cookie-1; Max-Age=${sc.call.cookie_max_age_s}`, "cookie-2; Max-Age=3600"].map((c) => ({
        status: 200,
        setCookies: [`gravity=${c}`],
        headers: { "x-grvt-account-id": "acc-1" },
      })),
    );
  const events: Event[] = [];
  const c = new Grvt({
    env: gw.env(),
    webSocket: gw.factory,
    http,
    apiKey: "k",
    encoding: lite ? "lite" : "full",
    onEvent: (e) => e.type !== "frame" && events.push(e),
    ...(sc.call.resync_timeout_ms ? { resyncTimeoutMs: sc.call.resync_timeout_ms } : {}),
    ...(sc.call.queue_size ? { queueSize: sc.call.queue_size } : {}),
  });
  clients.push(c);
  const instruments = sc.call.instruments ?? ["BTC_USDT_Perp"];
  const selectors = stream === "v1.order" ? ["42"] : instruments.map((i) => `${i}@500`);
  const subs: Subscription<{ sequence_number: string }>[] = await Promise.all(
    instruments.map((instrument) => {
      if (stream === "v1.order") return c.orderStream({ sub_account_id: "42" }).subscribe();
      const selector = { instrument, rate: 500 };
      return stream === "v1.ticker.d"
        ? c.tickerDeltaStream(selector).subscribe()
        : c.tickerSnapStream(selector).subscribe();
    }),
  );
  const sub = subs[0]!;
  const count = (type: string) => events.filter((e) => e.type === type).length;
  for (const step of sc.steps ?? []) {
    if (step.push)
      gw.push(
        stream,
        selectors[0]!,
        step.push[0],
        step.push[1],
        ...(step.feed ? [step.feed.value] : []),
      );
    else if (step.drop) gw.dropAll();
    else if (step.ignore_subscribes) gw.ignoreSubscribes = step.ignore_subscribes;
    else if (step.ack_latest) gw.ackLatest = String(step.ack_latest);
    else if (step.wait_acks)
      await waitUntil("acks", () => count("subscribe") >= step.wait_acks!, 5000);
    else if (step.wait_reconnects)
      await waitUntil("reconnects", () => count("reconnect") >= step.wait_reconnects!, 5000);
    else if (step.wait_dropped)
      await waitUntil("dropped", () => sub.dropped >= step.wait_dropped!, 5000);
  }
  const want = sc.expect;
  // Each subscription in order: the first's expectations, then other_subscriptions.
  const wanted = [{ items: want.items!, gaps: want.gaps! }, ...(want.other_subscriptions ?? [])];
  expect(wanted).toHaveLength(subs.length);
  const num = (s: string | undefined) => (s === undefined ? null : Number(s));
  for (const [i, w] of wanted.entries()) {
    const items = await take(subs[i]!, w.items.length);
    for (const x of items)
      if (x instanceof StreamOverflow) expect(x.capacity).toBe(want.overflow_capacity);
    expect(
      items.map((x) =>
        x instanceof DecodeError
          ? "decode_error"
          : x instanceof StreamOverflow
            ? "stream_overflow"
            : x instanceof Error
              ? x.message
              : Number(x.sequence_number),
      ),
    ).toEqual(w.items);
    const gaps = events.flatMap((e) =>
      e.type === "gap" && e.selector === selectors[i] ? [e] : [],
    );
    expect(
      gaps.map((e, n) => ({
        reason: e.gap.reason,
        after: num(e.gap.afterSequence),
        through: num(e.gap.throughSequence),
        // the legacy seq and prev, when the data gives them; the legacy expected prev is after
        ...(w.gaps[n]?.frame && e.expectedPrev === e.gap.afterSequence
          ? { frame: [num(e.seq), num(e.prev)] }
          : {}),
      })),
    ).toEqual(w.gaps);
  }
  for (const selector of selectors)
    expect(gw.subscribes().filter((s) => s.params.selectors.includes(selector))).toHaveLength(
      want.subscribes!,
    );
  if (want.subscribe_request) expect(gw.subscribes()[0].params).toEqual(want.subscribe_request);
  if (want.unsubscribes !== undefined) {
    sub.close();
    await waitUntil("unsubscribes", () => gw.rpcs("unsubscribe").length >= want.unsubscribes!);
    expect(gw.rpcs("unsubscribe")).toHaveLength(want.unsubscribes);
  }
  const logins = http.callsTo("/auth/api_key/login").map((l) => l.at);
  if (want.logins !== undefined) expect(logins).toHaveLength(want.logins);
  if (want.relogin_after_ms) {
    const [low, high] = want.relogin_after_ms;
    expect(logins[1]! - logins[0]!).toBeGreaterThanOrEqual(low);
    expect(logins[1]! - logins[0]!).toBeLessThanOrEqual(high);
  }
  if (want.session_rotated) {
    const rotated = events.flatMap((e) => (e.type === "session_rotated" ? [e] : []));
    expect(rotated.every((e) => e.websocketReconnectRequired)).toBe(true);
    expect(rotated.map((e) => e.generation)).toEqual(want.session_rotated);
  }
  if (want.handshake_logins)
    expect(gw.conns.map((s) => Number(s.headers.Cookie?.split("-")[1]))).toEqual(
      want.handshake_logins,
    );
  expect(gw.violations).toEqual([]);
}

async function runPages(sc: Scenario): Promise<void> {
  const replies = [...sc.replies!];
  const cursors: (string | null)[] = [];
  const failure = new Error("lookup failed");
  const fetch = async (cursor: string | undefined) => {
    cursors.push(cursor ?? null);
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply.fail) throw failure;
    return { result: [], next: reply.next };
  };
  const want = sc.expect;
  const g = sc.call.gap;
  const gap: GapRange | undefined = g && {
    reason: g.reason as GapRange["reason"],
    ...(g.after === null ? {} : { afterSequence: String(g.after) }),
    ...(g.through === null ? {} : { throughSequence: String(g.through) }),
  };
  const iterator: AsyncIterator<any> = gap ? backfillPages(fetch, gap) : pages(fetch);
  expect(cursors, "fetched before the first page was read").toEqual([]);
  const pagesRead: any[] = [];
  let err: unknown;
  try {
    while (pagesRead.length !== sc.call.take) {
      const r = await iterator.next();
      if (r.done) break;
      pagesRead.push(r.value);
    }
  } catch (e) {
    err = e;
  }
  const got =
    err === undefined
      ? "ok"
      : err instanceof PaginationCycle
        ? "pagination_cycle"
        : err === failure
          ? "fetch_error"
          : String(err);
  expect(got).toBe(want.outcome);
  if (err instanceof PaginationCycle) expect(err.cursor).toBe(want.cursor);
  expect(pagesRead).toHaveLength(want.pages!);
  expect(cursors).toEqual(want.cursors);
  if (gap) {
    expect(pagesRead.map((p) => p.historyExhausted)).toEqual(want.history_exhausted);
    for (const p of pagesRead) expect(p).toMatchObject({ continuity: want.continuity, gap });
  }
}

const run = { stream: runStream, pages: runPages, backfill: runPages } as Record<
  string,
  (sc: Scenario, lite: boolean) => Promise<void>
>;

// A scenario this SDK can't run says why in its "skip" entry; the reason shows in the test name. Pages
// and backfill never touch the wire, so they run once.
for (const sc of scenarios)
  for (const lite of sc.call.kind === "pages" || sc.call.kind === "backfill"
    ? [false]
    : [false, true])
    it.skipIf(sc.skip?.typescript !== undefined)(
      (sc.skip?.typescript ? `${sc.name} (skipped: ${sc.skip.typescript})` : sc.name) +
        (lite ? " [lite]" : ""),
      () => (run[sc.call.kind] ?? runCall)(sc, lite),
      10_000,
    );

import { Decimal } from "../src/runtime/scalars.js";
// Streams and WS order entry against the in-memory fake gateway.

import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  type ClientOptions,
  type Event,
  Grvt,
  type models as m,
  OrderStateUnknown,
  TransportError,
  PrivateKeySigner,
  StreamOverflow,
} from "../src/index.js";
import { FakeGateway, FakeHttp, FULL, take, waitUntil } from "./fakes.js";

const KEY = "0xbfe25ff07bd38cb3fbc28a2a296d41aabd68a78c929d257935906489fc9c6d89";
const clients: Grvt[] = [];

function client(gw: FakeGateway, opts: ClientOptions = {}): { c: Grvt; events: Event[] } {
  const events: Event[] = [];
  const c = new Grvt({
    ...FULL,
    env: gw.env(),
    webSocket: gw.factory,
    http: new FakeHttp(),
    onEvent: (e) => e.type !== "frame" && events.push(e),
    ...opts,
  });
  clients.push(c);
  return { c, events };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("write reply outcomes", () => {
  it.each([
    false,
    0,
    "",
    { code: 1003 },
    { code: [1003], message: "bad" },
    { code: 1002, message: "internal" },
  ])("does not treat malformed or server error as a write rejection: %j", async (error) => {
    const gw = new FakeGateway();
    gw.ignoreRpcs.add("v1/cancel_order");
    const { c } = client(gw, { apiKey: "k", orderTransport: "ws", wsRequestTimeoutMs: 100 });
    const out = c.cancelOrder({ sub_account_id: "1", client_order_id: "7" }).catch((e) => e);
    await waitUntil("sent", () => gw.rpcs("v1/cancel_order").length === 1);
    const request = gw.rpcs("v1/cancel_order")[0];
    gw.conns[0]!.deliver({ id: request.id, error, result: { result: { ack: true } } });
    expect(await out).toBeInstanceOf(OrderStateUnknown);
  });
});

describe("streams", () => {
  it("works with for await and unsubscribes on break", async () => {
    const gw = new FakeGateway();
    const { c } = client(gw);
    const got: string[] = [];
    setTimeout(() => {
      gw.push("v1.trade", "BTC_USDT_Perp@50", 1, 0);
      gw.push("v1.trade", "BTC_USDT_Perp@50", 2, 1);
    }, 30);
    for await (const f of c.tradeStream({ instrument: "BTC_USDT_Perp", limit: 50 })) {
      got.push(f.sequence_number!);
      if (got.length === 3) break;
    }
    expect(got).toEqual(["0", "1", "2"]);
    await waitUntil("unsubscribe", () => gw.rpcs("unsubscribe").length === 1);
  });

  it("a slow consumer of a public event stream gets StreamOverflow too: only snapshot streams drop", async () => {
    const gw = new FakeGateway();
    const { c } = client(gw, { queueSize: 2 });
    const sub = await c.tradeStream({ instrument: "X", limit: 500 }).subscribe();
    gw.push("v1.trade", "X@500", 1, 0);
    gw.push("v1.trade", "X@500", 2, 1);
    gw.push("v1.trade", "X@500", 3, 2);
    await waitUntil("re-subscribe", () => gw.subscribes().length === 2);
    expect(sub.dropped).toBe(0);
    const items = await take(sub, 1);
    expect(items[0]).toBeInstanceOf(StreamOverflow);
  });

  it("stops for good when the handshake is rejected", async () => {
    const gw = new FakeGateway();
    gw.rejectHandshake = 401;
    const { c, events } = client(gw);
    const err = await c
      .tickerDeltaStream({ instrument: "X" })
      .subscribe()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).retryable).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", fatal: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(gw.conns).toHaveLength(1);
  });
});

function order(): m.OrderInput {
  return {
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
  };
}

function trading(gw: FakeGateway, opts: ClientOptions = {}) {
  const r = client(gw, {
    apiKey: "k",
    signer: new PrivateKeySigner(KEY),
    orderTransport: "ws",
    ...opts,
  });
  r.c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
    instrument_hash: "0x030501",
    base_decimals: 9,
  });
  return r;
}

describe("WS order entry", () => {
  it("signs, fills client_order_id and sends once", async () => {
    const gw = new FakeGateway();
    gw.rpcResult = (_m, p) => ({ result: { ...p.order, order_id: "0x1" } });
    const { c } = trading(gw);
    const resp = await c.createOrder({ order: order() });
    expect(resp.result?.order_id).toBe("0x1");
    const sent = gw.rpcs("v1/create_order");
    expect(sent).toHaveLength(1);
    expect(sent[0].params.order.signature.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent[0].params.order.metadata.client_order_id).toMatch(/^\d+$/);
    expect(resp.result?.metadata?.client_order_id).toBe(
      sent[0].params.order.metadata.client_order_id,
    );
    expect(gw.conns[0]!.headers.Cookie).toBe("gravity=cookie-1");
  });

  it("a timeout is OrderStateUnknown and is not retried", async () => {
    const gw = new FakeGateway();
    gw.ignoreRpcs.add("v1/create_order");
    const { c } = trading(gw, { wsRequestTimeoutMs: 100 });
    const o = order();
    o.metadata = { client_order_id: "777" };
    const err = await c.createOrder({ order: o }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderStateUnknown);
    expect((err as OrderStateUnknown).clientOrderId).toBe("777");
    expect(err.cause).toBeInstanceOf(TransportError);
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.rpcs("v1/create_order")).toHaveLength(1);
    expect(o.metadata.client_order_id).toBe("777"); // the caller's object is not touched
  });

  it("a send that throws may have left: a write is OrderStateUnknown", async () => {
    const gw = new FakeGateway();
    const { c } = trading(gw);
    await c.createOrder({ order: order() }); // opens the socket
    gw.conns[0]!.send = () => {
      throw new Error("reset mid-frame");
    };
    const o = order();
    o.metadata = { client_order_id: "778" };
    const err = await c.createOrder({ order: o }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderStateUnknown);
    expect((err as OrderStateUnknown).clientOrderId).toBe("778");
    expect(err.cause).toBeInstanceOf(TransportError);
    expect((err.cause as TransportError).sent).toBe(true);
  });

  it("reads go over REST even when orders use WS; the WS result is the REST body", async () => {
    const gw = new FakeGateway();
    gw.rpcResult = () => ({ result: { instrument: "BTC_USDT_Perp" } });
    const { c } = trading(gw);
    const raw = await c.runtime.md.request(
      "v1/instrument",
      '{"instrument":"BTC_USDT_Perp"}',
      false,
    );
    expect(raw).toEqual({ result: { instrument: "BTC_USDT_Perp" } });
    const http = c.runtime.http as FakeHttp;
    await c.getInstrument({ instrument: "BTC_USDT_Perp" });
    expect(http.callsTo("/full/v1/instrument")).toHaveLength(1);
  });
});

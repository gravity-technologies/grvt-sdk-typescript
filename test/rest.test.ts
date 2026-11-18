import { Decimal } from "../src/runtime/scalars.js";
// REST calls, login, retries and writes against a fake HTTP transport.

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  ConfigError,
  ErrorCode,
  type Event,
  Grvt,
  type models as m,
  OrderOutOfBounds,
  OrderStateUnknown,
  PrivateKeySigner,
  RateLimitError,
} from "../src/index.js";
import { fixture } from "./fixtures.js";
import { FakeHttp, FULL, sentNoAnswer } from "./fakes.js";

const KEY = "0xbfe25ff07bd38cb3fbc28a2a296d41aabd68a78c929d257935906489fc9c6d89";
const err503 = { status: 503, body: '{"code":0,"message":"busy","status":503}' };

function setup(withKey = true) {
  const http = new FakeHttp();
  const events: Event[] = [];
  const c = new Grvt({
    ...FULL,
    env: "testnet",
    http,
    apiKey: withKey ? "k" : undefined,
    signer: new PrivateKeySigner(KEY),
    onEvent: (e) => events.push(e),
  });
  c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
    instrument_hash: "0x030501",
    base_decimals: 9,
  });
  return { c, http, events };
}

const order = (): m.OrderInput => ({
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
});

describe("REST", () => {
  it("public reads send no session; private calls log in once and send cookie + account id", async () => {
    const { c, http } = setup();
    http.on("/full/v1/ticker", {
      body: '{"result":{"instrument":"BTC_USDT_Perp","mark_price":"65000.1"}}',
    });
    const t = await c.ticker({ instrument: "BTC_USDT_Perp" });
    expect(t.result?.mark_price?.toString()).toBe("65000.1");
    expect(http.calls[0]!.url).toBe("https://market-data.testnet.grvt.io/full/v1/ticker");
    expect(http.calls[0]!.headers.Cookie).toBeUndefined();
    expect(http.logins).toBe(0);

    await Promise.all([
      c.subAccountSummary({ sub_account_id: "1" }),
      c.subAccountSummary({ sub_account_id: "2" }),
    ]);
    expect(http.logins).toBe(1);
    const call = http.callsTo("/full/v1/account_summary")[0]!;
    expect(call.url.startsWith("https://trades.testnet.grvt.io")).toBe(true);
    expect(call.headers).toMatchObject({
      Cookie: "gravity=cookie-1",
      "X-Grvt-Account-Id": "acc-1",
    });
    expect(c.runtime.session.generation).toBe(1);
  });

  it("printing the session never shows the cookie", async () => {
    const { c } = setup();
    await c.subAccountSummary({ sub_account_id: "1" });
    expect(c.runtime.session.cookie).toBe("cookie-1");
    const shown = [
      inspect(c.runtime.session),
      inspect({ session: c.runtime.session }, { depth: 5 }),
      JSON.stringify(c.runtime.session),
    ];
    for (const text of shown) {
      expect(text).not.toContain("cookie-1");
      expect(text).toContain("<redacted>");
    }
  });

  it("signs the session's main account, loaded once from funding_account_summary", async () => {
    const { c, http } = setup();
    const main = "0x0c3e7b0a6c8a1b2d3e4f5a6b7c8d9e0f1a2b3c4d";
    http.on("/full/v1/funding_account_summary", err503, {
      body: JSON.stringify(
        fixture("ApiFundingAccountSummaryResponse", {
          result: fixture("FundingAccountSummary", { main_account_id: main }),
        }),
      ),
    });
    http.on("/full/v1/vault_burn_tokens", { body: '{"result":{"ack":true}}' });
    const burn = { vault_id: "1", currency: "USDT", num_tokens: new Decimal("1.5") };
    await c.vaultBurnTokens(burn);
    await c.vaultBurnTokens(burn);
    // A read retries the 503; the loaded account is then cached for the second burn.
    expect(http.callsTo("/full/v1/funding_account_summary")).toHaveLength(2);
    expect(http.callsTo("/full/v1/vault_burn_tokens")).toHaveLength(2);
  });
  it("an authenticated call without an api key is a ConfigError, nothing sent", async () => {
    const { c, http } = setup(false);
    await expect(c.subAccountSummary({ sub_account_id: "1" })).rejects.toThrow(ConfigError);
    expect(http.calls).toHaveLength(0);
  });

  it("reads do not retry a non-retryable error; rate limits are RateLimitError", async () => {
    const { c, http } = setup();
    http.on("/full/v1/ticker", { status: 400, body: '{"code":3000,"message":"bad","status":400}' });
    const err = await c.ticker({ instrument: "X" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(3000);
    expect(http.callsTo("/full/v1/ticker")).toHaveLength(1);

    http.on("/full/v1/ticker", {
      status: 429,
      body: '{"code":1006,"message":"slow down","status":429}',
    });
    const rl = await c.ticker({ instrument: "X" }).catch((e) => e);
    expect(rl).toBeInstanceOf(RateLimitError);
    expect(rl).toBeInstanceOf(ApiError);
    expect(rl.code).toBe(ErrorCode.RATE_LIMIT);
    expect(http.callsTo("/full/v1/ticker")).toHaveLength(4);
  });

  it.each([
    { status: 200, body: "not json" },
    { status: 200, body: "null" },
    { status: 400, body: '{"code":[1003],"message":"bad"}' },
    { status: 200, body: '{"result":{"order_id":{}}}' },
    { status: 400, body: "proxy failed" },
    { status: 503, body: '{"code":1002,"message":"busy"}' },
  ])("keeps ambiguous write replies and their cause: %j", async (reply) => {
    const { c, http } = setup();
    http.on("/full/v1/create_order", reply);
    const err = await c.createOrder({ order: order() }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderStateUnknown);
    expect(err.cause).toBeInstanceOf(Error);
    const sent = JSON.parse(http.callsTo("/full/v1/create_order")[0]!.body);
    expect(err.clientOrderIds).toEqual([sent.order.metadata.client_order_id]);
    expect(http.callsTo("/full/v1/create_order")).toHaveLength(1);
  });

  it.each([false, true])("reports the IDs submitted after beforeSend (bulk=%s)", async (bulk) => {
    const http = new FakeHttp();
    const c = new Grvt({
      ...FULL,
      env: "testnet",
      http,
      apiKey: "k",
      signer: new PrivateKeySigner(KEY),
      beforeSend: (call) => {
        const orders = bulk
          ? (call.params.orders as m.OrderInput[])
          : [call.params.order as m.OrderInput];
        for (const o of orders) o.metadata = { client_order_id: "99" };
        if (bulk) orders.splice(1);
      },
    });
    c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
      instrument_hash: "0x030501",
      base_decimals: 9,
    });
    http.on(bulk ? "/full/v2/bulk_orders" : "/full/v1/create_order", sentNoAnswer());
    const e = await (
      bulk
        ? c.bulkOrders({ sub_account_id: "1", orders: [order(), order()] })
        : c.createOrder({ order: order() })
    ).catch((error) => error);
    expect(e).toBeInstanceOf(OrderStateUnknown);
    expect(e.clientOrderIds).toEqual(["99"]);
  });

  it("bulkOrders signs each order on its own and fills each client_order_id", async () => {
    const { c, http } = setup();
    http.on("/full/v2/bulk_orders", { body: '{"orders":[],"cancel_acks":[]}' });
    const withBuilder: m.OrderInput = {
      ...order(),
      builder: "0x" + "22".repeat(20),
      builder_fee: new Decimal("0.001"),
      metadata: { client_order_id: "42" },
    };
    await c.bulkOrders({
      sub_account_id: "8289849667772468",
      orders: [order(), withBuilder],
    });
    const sent = JSON.parse(http.callsTo("/full/v2/bulk_orders")[0]!.body).orders;
    expect(sent[0].metadata.client_order_id).toMatch(/^\d+$/);
    expect(sent[1].metadata.client_order_id).toBe("42");
    expect(sent[0].signature.nonce).not.toBe(sent[1].signature.nonce);
    for (const o of sent) expect(o.signature.r).toMatch(/^0x[0-9a-f]{64}$/);
    // A pure bulk cancel has nothing to sign and needs no signer.
    const noSigner = new Grvt({ ...FULL, env: "testnet", http, apiKey: "k" });
    await noSigner.bulkOrders({ sub_account_id: "1", client_order_ids: ["42"] });
    const cancel = JSON.parse(http.callsTo("/full/v2/bulk_orders")[1]!.body);
    expect(cancel.orders).toBeUndefined();
    expect(cancel.client_order_i_ds).toEqual(["42"]);
    expect(cancel.client_order_ids).toBeUndefined();
  });

  it("a bulk write whose answer is lost is OrderStateUnknown with every client_order_id", async () => {
    const { c, http } = setup();
    http.on("/full/v2/bulk_orders", sentNoAnswer());
    const err = await c
      .bulkOrders({ sub_account_id: "8289849667772468", orders: [order(), order()] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OrderStateUnknown);
    const sent = JSON.parse(http.callsTo("/full/v2/bulk_orders")[0]!.body).orders;
    expect(err.clientOrderIds).toEqual(sent.map((o: any) => o.metadata.client_order_id));
    expect(err.clientOrderIds).toHaveLength(2);
    expect(err.clientOrderId).toBeUndefined();
    expect(err.message).toContain("client_order_ids=");
  });

  it("an order the gateway rejects for its limits drops that instrument's metadata, and is not resent", async () => {
    const { c, http } = setup();
    c.runtime.metadata.putInstrument("ETH_USDT_Perp", {
      instrument_hash: "0x030401",
      base_decimals: 9,
    });
    http.on("/full/v1/create_order", {
      status: 400,
      body: '{"code":2064,"message":"Invalid limit price tick","status":400}',
    });
    http.on("/full/v1/instrument", {
      body: JSON.stringify({
        result: fixture("InstrumentDisplay", {
          instrument: "BTC_USDT_Perp",
          instrument_hash: "0x030501",
          base_decimals: 9,
          tick_size: "0.1",
          min_size: "0",
          min_notional: "0",
        }),
      }),
    });
    await expect(c.createOrder({ order: order() })).rejects.toThrow(ApiError);
    expect(http.callsTo("/full/v1/create_order")).toHaveLength(1);
    expect(http.callsTo("/full/v1/instrument")).toHaveLength(0);
    // The next order refetches BTC (rejected above) but not ETH.
    await expect(c.createOrder({ order: order() })).rejects.toThrow(ApiError);
    expect(http.callsTo("/full/v1/instrument")).toHaveLength(1);
  });

  it("an order off its instrument's tick is refused before signing, nothing sent", async () => {
    const { c, http } = setup();
    c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
      instrument_hash: "0x030501",
      base_decimals: 9,
      limits: { tick_size: "0.1", min_size: "0.001", min_notional: "100" },
    });
    const bad = {
      ...order(),
      legs: [
        {
          instrument: "BTC_USDT_Perp",
          size: new Decimal("0.01"),
          limit_price: new Decimal("65000.13"),
          is_buying_asset: true,
        },
      ],
    };
    const err = await c.createOrder({ order: bad }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderOutOfBounds);
    expect(err.nearest).toEqual(["65000.1", "65000.2"]);
    expect(http.calls).toHaveLength(0);
  });

  it("with checkOrders off, an off-tick order is signed and sent", async () => {
    const http = new FakeHttp();
    const c = new Grvt({
      ...FULL,
      env: "testnet",
      http,
      apiKey: "k",
      signer: new PrivateKeySigner(KEY),
      checkOrders: false,
    });
    c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
      instrument_hash: "0x030501",
      base_decimals: 9,
      limits: { tick_size: "0.1", min_size: "0.001", min_notional: "100" },
    });
    http.on("/full/v1/create_order", {
      body: JSON.stringify({ result: fixture("Order", { order_id: "0x1" }) }),
    });
    const leg = {
      instrument: "BTC_USDT_Perp",
      size: new Decimal("0.01"),
      limit_price: new Decimal("65000.13"),
      is_buying_asset: true,
    };
    await c.createOrder({ order: { ...order(), legs: [leg] } });
    const sent = JSON.parse(http.callsTo("/full/v1/create_order")[0]!.body);
    expect(sent.order.legs[0].limit_price).toBe("65000.13");
    expect(sent.order.signature.r).toMatch(/^0x/);
  });

  it("signs create_order, loading instrument metadata once", async () => {
    const { c, http } = setup();
    (c.runtime.metadata as unknown as { instruments: Map<string, unknown> }).instruments.clear(); // force a load
    http.on("/full/v1/instrument", {
      body: JSON.stringify({
        result: fixture("InstrumentDisplay", {
          instrument: "BTC_USDT_Perp",
          instrument_hash: "0x030501",
          base_decimals: 9,
          tick_size: "0.1",
          min_size: "0",
          min_notional: "0",
        }),
      }),
    });
    await c.createOrder({ order: order() });
    await c.createOrder({ order: order() });
    expect(http.callsTo("/full/v1/instrument")).toHaveLength(1);
    const sent = JSON.parse(http.callsTo("/full/v1/create_order")[0]!.body);
    expect(sent.order.signature).toMatchObject({
      signer: "0x1267c6181aee40f5ddbd70c56ecf4613117326b5",
      chain_id: "326",
    });
    expect(sent.order.signature.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof sent.order.signature.nonce).toBe("number");
  });

  it("beforeSend runs before signing; required fields are checked before anything else", async () => {
    const http = new FakeHttp();
    const seen: unknown[] = [];
    const c = new Grvt({
      ...FULL,
      http,
      apiKey: "k",
      signer: new PrivateKeySigner(KEY),
      beforeSend: (call) => {
        seen.push(structuredClone(call.params));
        (call.params.order as m.OrderInput).post_only = true;
      },
    });
    c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
      instrument_hash: "0x030501",
      base_decimals: 9,
    });
    await c.createOrder({ order: order() });
    expect((seen[0] as { order: m.OrderInput }).order.signature?.r).toBeUndefined();
    const sent = JSON.parse(http.callsTo("/full/v1/create_order")[0]!.body);
    expect(sent.order.post_only).toBe(true);
    expect(sent.order.signature.r).toBeDefined();

    await expect(c.createOrder({} as never)).rejects.toThrow(/order is required/);
    await expect(
      c.createOrder({
        order: {
          ...order(),
          legs: [
            {
              instrument: "BTC_USDT_Perp",
              size: new Decimal("0.0000000001"),
              is_buying_asset: true,
            },
          ],
        },
      }),
    ).rejects.toThrow(/decimal places/);
    expect(http.callsTo("/full/v1/create_order")).toHaveLength(1);
  });
});

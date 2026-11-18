// The lite wire encoding: the generated table against the contract, per-type renames (nested, repeated
// and unknown names), the WebSocket envelope, and lite clients against the fakes, compared with full ones.

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShared } from "./shared.js";
import {
  ApiError,
  ConfigError,
  type ClientOptions,
  Decimal,
  ERRORS,
  ENVIRONMENTS,
  FixedClock,
  Grvt,
  type models as m,
  PrivateKeySigner,
  Runtime,
  SigningError,
  specs,
} from "../src/index.js";
import { Api } from "../src/generated/api.js";
import { LITE, RPCS, STREAMS, TYPES } from "../src/generated/lite.js";
import { FakeGateway, FakeHttp, take } from "./fakes.js";
import { fixture } from "./fixtures.js";
import { allKeys, toFull as refToFull, toLite as refToLite } from "./reference/lite.js";

const contract = loadShared("contract/contract.json");
const types = new Map<string, any>(contract.types.map((t: any) => [t.name, t]));
const enums = new Map<string, any>(contract.enums.map((e: any) => [e.name, e]));
const KEY = "0xbfe25ff07bd38cb3fbc28a2a296d41aabd68a78c929d257935906489fc9c6d89";

const clients: Grvt[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** Every field of `type` set (wire names, wire values), nested types `depth` deep, arrays of two. */
function sample(type: string, depth = 2): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of (TYPES[type] ?? []) as readonly (readonly [string, string, string?])[]) {
    const [name, , nested] = f;
    let v: unknown = nested ? (depth > 0 ? sample(nested, depth - 1) : {}) : `v-${name}`;
    const field = types.get(type)?.fields?.find((x: any) => x.name === name);
    for (let d = 0; d < (field?.array_depth ?? 0); d++) v = [v, v];
    out[name] = v;
  }
  return out;
}

describe("generated lite table", () => {
  it("has the contract's lite name for every field of every gateway type", () => {
    for (const t of contract.types) {
      const want = (t.fields ?? []).map((f: any) =>
        f.kind === "struct" ? [f.name, f.lite, f.type] : [f.name, f.lite],
      );
      expect(TYPES[t.name], t.name).toEqual(want);
    }
    for (const t of contract.edge.types) expect(TYPES[t.name], t.name).toBeUndefined();
  });

  it("has the lite path and types of every gateway RPC and the feed type of every stream", () => {
    for (const r of contract.rpcs) {
      const [path, request, response] = RPCS[r.id]!;
      expect(path, r.id).toBe(
        contract.transport.lite.http_path_template
          .replace("{version}", r.version)
          .replace("{route}", r.route),
      );
      expect(path).toBe(r.http_path.replace(/^\/full\//, "/lite/"));
      expect(TYPES[request], request).toBeDefined();
      expect(TYPES[response], response).toBeDefined();
    }
    for (const s of contract.streams) {
      const feed = types.get(s.feed_type).fields.find((f: any) => f.name === "feed");
      // A partial feed uses the SDK copy (Partial*), with the same names.
      expect([feed.type, `Partial${feed.type}`], s.id).toContain(STREAMS[s.id]);
      expect(TYPES[STREAMS[s.id]!]).toEqual(TYPES[feed.type]);
    }
  });
});

describe("LiteCodec", () => {
  it("renames every type both ways, nested and in arrays, like the reference", () => {
    for (const type of Object.keys(TYPES)) {
      const full = sample(type);
      const lite = LITE.toLite(full, type);
      // SDK-only copies (*Input, Partial*) share their base type's names; the reference reads the base.
      const base = type.replace(/^Partial/, "").replace(/Input$/, "");
      expect(lite, type).toEqual(refToLite(full, types.has(type) ? type : base));
      expect(LITE.toFull(lite, type), type).toEqual(full);
    }
  });

  it("renames per type: the same lite name means different fields in different types", () => {
    const frame = {
      s: "v1.book.s",
      s1: "BTC_USDT_Perp@500-10",
      sn: "12",
      ps: "11",
      f: {
        et: "1730000000000000000",
        i: "BTC_USDT_Perp",
        b: [{ p: "65000.1", s: "0.5", no: 3 }],
        a: [{ p: "65001", s: "1.25", no: 1 }],
      },
    };
    expect(LITE.toFull(frame, "WSOrderbookLevelsFeedDataV1")).toEqual({
      stream: "v1.book.s",
      selector: "BTC_USDT_Perp@500-10",
      sequence_number: "12",
      prev_sequence_number: "11",
      feed: {
        event_time: "1730000000000000000",
        instrument: "BTC_USDT_Perp",
        bids: [{ price: "65000.1", size: "0.5", num_orders: 3 }],
        asks: [{ price: "65001", size: "1.25", num_orders: 1 }],
      },
    });
  });

  it("skips unknown keys on decode and rejects them on encode", () => {
    expect(LITE.toFull({ i: "BTC_USDT_Perp", fi: "x" }, "Ticker")).toEqual({
      instrument: "BTC_USDT_Perp",
    });
    expect(() => LITE.toLite({ instrument: "BTC", oops: 1 }, "ApiGetInstrumentRequest")).toThrow(
      ConfigError,
    );
    expect(() => LITE.toLite({}, "NoSuchType")).toThrow(ConfigError);
    expect(() => LITE.rpc("edge.api_key_login")).toThrow(ConfigError);
  });

  it("passes null, scalars and empty arrays through", () => {
    expect(LITE.toFull(null, "Ticker")).toBeNull();
    expect(LITE.toFull({ i: null }, "Ticker")).toEqual({ instrument: null });
    expect(LITE.toLite({ orders: [] }, "ApiBulkOrdersRequest")).toEqual({ o: [] });
  });

  it("reads the WebSocket envelope: replies, errors with id 0, bare errors and stream frames", () => {
    // RPC results are double-wrapped and stay lite until the caller renames them by response type.
    expect(LITE.inbound({ j: "2.0", i: 7, r: { r: { i: "BTC" } }, m: "v1/instrument" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { r: { i: "BTC" } },
      method: "v1/instrument",
    });
    expect(LITE.inbound({ j: "2.0", i: 0, m: "", e: { c: 1000, m: "denied" } })).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "",
      error: { code: 1000, message: "denied" },
    });
    expect(LITE.inbound({ c: 1003, m: "bad", s: 400 })).toEqual({
      code: 1003,
      message: "bad",
      status: 400,
    });
    // The same body with a reply id is still an error, not a reply whose `m` is the method.
    expect(LITE.inbound({ j: "2.0", i: 7, c: 2064, m: "tick", s: 400 })).toEqual({
      id: 7,
      code: 2064,
      message: "tick",
      status: 400,
    });
    const frame = LITE.inbound({ s: "v1.ticker.s", s1: "X@500", sn: "1", ps: "0", f: { i: "X" } });
    expect(frame).toEqual({
      stream: "v1.ticker.s",
      selector: "X@500",
      sequence_number: "1",
      prev_sequence_number: "0",
      feed: { i: "X" },
    });
    expect(LITE.feed(frame, "ticker.ticker_snap")).toEqual({ ...frame, feed: { instrument: "X" } });
    expect(LITE.subscribeResult({ s: "v1.ticker.s", s1: ["X@500"], ls: ["5"], ns: [1] })).toEqual({
      stream: "v1.ticker.s",
      subs: ["X@500"],
      latest_sequence_number: ["5"],
      num_snapshots: [1],
    });
    expect(JSON.parse(LITE.frame("v1/instrument", '{"i":"X"}', 9))).toEqual({
      j: "2.0",
      m: "v1/instrument",
      p: { i: "X" },
      i: 9,
    });
    expect(LITE.httpError({ c: 1003, m: "bad", s: 400, ri: 5 })).toEqual({
      code: 1003,
      message: "bad",
      status: 400,
      request_id: 5,
    });
  });
});

function client(gw: FakeGateway, http: FakeHttp, opts: ClientOptions = {}): Grvt {
  const c = new Grvt({ env: gw.env(), webSocket: gw.factory, http, ...opts });
  clients.push(c);
  return c;
}

/** A full and a lite client against fakes speaking their encoding, with the same fixed inputs. */
function pair(opts: ClientOptions = {}) {
  const make = (lite: boolean) => {
    const gw = new FakeGateway({ lite });
    const http = new FakeHttp({ lite });
    let id = 0;
    const c = client(gw, http, {
      encoding: lite ? "lite" : "full",
      apiKey: "k",
      signer: new PrivateKeySigner(KEY),
      clock: new FixedClock(1730000000000000000n),
      nonces: { nextNonce: () => 42 },
      clientOrderIds: { nextId: () => String((1n << 63n) + BigInt(++id)) },
      ...opts,
    });
    c.runtime.metadata.putInstrument("BTC_USDT_Perp", {
      instrument_hash: "0x030501",
      base_decimals: 9,
    });
    return { gw, http, c };
  };
  return { full: make(false), lite: make(true) };
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

describe("lite client against the fakes", () => {
  it("sends REST reads to the lite path with lite keys and decodes the same result", async () => {
    const { full, lite } = pair();
    const book = {
      result: {
        event_time: "1730000000000000000",
        instrument: "BTC_USDT_Perp",
        bids: [{ price: "65000.1", size: "0.5", num_orders: 3 }],
        asks: [],
      },
    };
    for (const s of [full, lite])
      s.http.on("/full/v1/book", { status: 200, body: JSON.stringify(book) });
    const a = await full.c.orderbookLevels({ instrument: "BTC_USDT_Perp", depth: 10 });
    const b = await lite.c.orderbookLevels({ instrument: "BTC_USDT_Perp", depth: 10 });
    expect(b).toEqual(a);
    expect(b.result?.bids?.[0]?.size).toEqual(new Decimal("0.5"));
    const call = lite.http.calls.at(-1)!;
    expect(call.url).toBe("http://fake-md/lite/v1/book");
    expect(JSON.parse(call.wire)).toEqual({ i: "BTC_USDT_Perp", d: 10 });
    expect(full.http.calls.at(-1)!.url).toBe("http://fake-md/full/v1/book");
    expect([...lite.http.violations, ...full.http.violations]).toEqual([]);
  });

  it.each(["rest", "ws"] as const)(
    "signs the same order and sends it with lite keys (%s)",
    async (orderTransport) => {
      const { full, lite } = pair({ orderTransport });
      await full.c.createOrder({ order: order() });
      await lite.c.createOrder({ order: order() });
      const sent = (s: typeof full) =>
        orderTransport === "ws"
          ? s.gw.rpcs("v1/create_order")[0].params
          : JSON.parse(s.http.callsTo("/full/v1/create_order")[0]!.body);
      // Translated back with the reference converter, the lite request is the full one, signature included.
      expect(sent(lite)).toEqual(sent(full));
      expect(sent(lite).order.signature.r).toMatch(/^0x/);
      const wire =
        orderTransport === "ws"
          ? lite.gw.wire.find((w) => w.m === "v1/create_order")
          : JSON.parse(lite.http.callsTo("/full/v1/create_order")[0]!.wire);
      const fullNames = allKeys(sent(full));
      expect([...allKeys(wire)].filter((k) => fullNames.has(k) && k.length > 3)).toEqual([]);
      expect([...lite.gw.violations, ...lite.http.violations]).toEqual([]);
      expect([...full.gw.violations, ...full.http.violations]).toEqual([]);
    },
  );

  it("streams the order book with lite frames and decodes the same items", async () => {
    const { full, lite } = pair();
    const feed = {
      event_time: "1730000000000000000",
      instrument: "BTC_USDT_Perp",
      bids: [{ price: "65000.1", size: "0.5", num_orders: 3 }],
      asks: [{ price: "65001", size: "1.25", num_orders: 1 }],
    };
    const items = [];
    for (const s of [full, lite]) {
      const sub = await s.c
        .orderbookDeltaStream({ instrument: "BTC_USDT_Perp", rate: 500 })
        .subscribe();
      s.gw.push("v1.book.d", "BTC_USDT_Perp@500", 1, 0, feed);
      items.push(await take(sub, 2));
      sub.close();
    }
    expect(items[1]).toEqual(items[0]);
    const delta = items[1]![1] as m.WSOrderbookLevelsFeedDataV1;
    expect(delta.feed?.asks?.[0]?.size).toEqual(new Decimal("1.25"));
    expect(delta.sequence_number).toBe("1");
    expect(lite.gw.wire.map((w) => w.m)).toEqual(["subscribe", "unsubscribe"]);
    expect(lite.gw.wire[0].p).toEqual({
      s: "v1.book.d",
      s1: ["BTC_USDT_Perp@500"],
      ug: true,
    });
    expect(lite.gw.violations).toEqual([]);
  });

  it("reads lite error bodies (REST and WS)", async () => {
    const { lite } = pair({ orderTransport: "ws" });
    lite.http.on("/full/v1/book", {
      status: 400,
      body: JSON.stringify({ code: 1003, message: "malformed", status: 400 }),
    });
    const err = await lite.c.orderbookLevels({ instrument: "X", depth: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.code, err.message.includes("malformed"), err.status]).toEqual([1003, true, 400]);

    lite.gw.ignoreRpcs.add("v1/cancel_order");
    const out = lite.c.cancelOrder({ sub_account_id: "1", client_order_id: "7" }).catch((e) => e);
    await vi.waitFor(() => expect(lite.gw.rpcs("v1/cancel_order")).toHaveLength(1));
    const id = lite.gw.rpcs("v1/cancel_order")[0].id;
    lite.gw
      .open()[0]!
      .deliver({ jsonrpc: "2.0", id, method: "", error: { code: 2000, message: "x" } });
    const wsErr = await out;
    expect(wsErr).toBeInstanceOf(ApiError);
    expect(wsErr.code).toBe(2000);

    // A REST-style error body with the reply id, sent as is (not renamed by the fake).
    const out2 = lite.c.cancelOrder({ sub_account_id: "1", client_order_id: "8" }).catch((e) => e);
    await vi.waitFor(() => expect(lite.gw.rpcs("v1/cancel_order")).toHaveLength(2));
    const id2 = lite.gw.rpcs("v1/cancel_order")[1].id;
    lite.gw.open()[0]!.onmessage?.({
      data: JSON.stringify({ j: "2.0", i: id2, c: 2064, m: "tick", s: 400 }),
    });
    const restStyle = await out2;
    expect(restStyle).toBeInstanceOf(ApiError);
    expect([restStyle.code, restStyle.message.includes("tick")]).toEqual([2064, true]);
  });

  it("keeps login and the edge in full names", async () => {
    const { lite } = pair();
    await lite.c.orderbookLevels({ instrument: "X", depth: 10 });
    await lite.c.getSubAccounts();
    const urls = lite.http.calls.map((c) => c.url);
    expect(urls).toContain("http://fake-edge/auth/api_key/login");
    expect(urls.filter((u) => u.includes("/full/"))).toEqual([]);
    expect(lite.http.violations).toEqual([]);
  });

  it("reaches every unsigned RPC on its lite path with every field in lite names", async () => {
    const http = new FakeHttp({ lite: true });
    const c = new Grvt({ apiKey: "k", http, encoding: "lite" });
    clients.push(c);
    const value = (f: any, depth: number): unknown => {
      let v: unknown =
        f.kind === "struct"
          ? depth > 0
            ? all(f.type, depth - 1)
            : fixture(f.type)
          : f.kind === "enum"
            ? enums.get(f.type).values[0].name
            : f.type === "bool"
              ? true
              : /^u?int(8|16|32)$/.test(f.type)
                ? 1
                : "1";
      for (let d = 0; d < (f.array_depth ?? 0); d++) v = [v];
      return v;
    };
    const all = (type: string, depth = 2): Record<string, unknown> =>
      Object.fromEntries(
        (types.get(type).fields ?? []).map((f: any) => [f.sdk_name ?? f.name, value(f, depth)]),
      );
    const outcomes: Record<string, number> = {};
    for (const op of specs.OPERATIONS.filter((o) => o.kind === "rpc")) {
      const rpc = contract.rpcs.find((r: any) => r.id === op.id);
      const err = await (c as any)[op.method](all(rpc.request)).then(
        () => undefined,
        (e: unknown) => e,
      );
      const urls = http.calls.map((x) => x.url).filter((u) => !u.includes("/auth/"));
      const sent = urls.at(-1)?.endsWith(RPCS[op.id]![0]) && http.calls.length > 0;
      // Signed calls stop at signing (no signer configured), before anything is sent.
      const outcome = sent
        ? "sent on the lite path"
        : err instanceof ConfigError || err instanceof SigningError
          ? "stopped at signing"
          : `${op.id}: ${String(err)}`;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      http.calls.length = 0;
    }
    expect(Object.keys(outcomes).sort()).toEqual(["sent on the lite path", "stopped at signing"]);
    expect(outcomes["sent on the lite path"]).toBeGreaterThan(contract.rpcs.length / 2);
    expect(http.violations).toEqual([]);
  });
});

describe("encoding option", () => {
  it("defaults to lite", async () => {
    const http = new FakeHttp({ lite: true });
    const api = new Api(
      new Runtime({ http }, { errors: ERRORS, environments: ENVIRONMENTS, lite: async () => LITE }),
    );
    await api.getInstrument({ instrument: "BTC_USDT_Perp" });
    await api.runtime.close();
    expect(api.runtime.encoding).toBe("lite");
    expect(http.calls[0]!.url).toBe("https://market-data.testnet.grvt.io/lite/v1/instrument");
    expect(http.violations).toEqual([]);
  });

  it("full never loads the lite table", async () => {
    const load = vi.fn<() => Promise<typeof LITE>>(async () => LITE);
    const http = new FakeHttp();
    const api = new Api(
      new Runtime(
        { http, encoding: "full" },
        { errors: ERRORS, environments: ENVIRONMENTS, lite: load },
      ),
    );
    await api.getInstrument({ instrument: "BTC_USDT_Perp" });
    await api.runtime.close();
    expect(api.runtime.encoding).toBe("full");
    expect(http.calls[0]!.url).toBe("https://market-data.testnet.grvt.io/full/v1/instrument");
    expect(load).not.toHaveBeenCalled();
  });

  it("uses the environment's lite WebSocket URLs", () => {
    const c = new Grvt({ encoding: "lite" });
    clients.push(c);
    expect(c.runtime.md.url).toBe(ENVIRONMENTS.testnet!.mdWsLiteUrl);
    expect(c.runtime.td.url).toBe("wss://trades.testnet.grvt.io/ws/lite");
  });

  it("rejects a bad value and a custom environment whose lite URLs cannot be derived", () => {
    expect(() => new Grvt({ encoding: "short" as never })).toThrow(ConfigError);
    const { mdWsLiteUrl: _md, tdWsLiteUrl: _td, ...env } = new FakeGateway().env();
    expect(() => new Grvt({ env, encoding: "lite" })).toThrow(/no lite URL; set mdWsLiteUrl/);
    expect(() => new Grvt({ env })).toThrow(/no lite URL; set mdWsLiteUrl/);
    expect(() => new Grvt({ env, encoding: "full" })).not.toThrow();
    expect(() => new Grvt({ env: { ...env, mdWsLiteUrl: "" }, encoding: "lite" })).toThrow(
      ConfigError,
    );
  });

  it("decodes what the reference converter makes of a full reply", () => {
    // Guards the fakes: the reference converter and the generated codec agree on a whole response.
    const problems: string[] = [];
    const resp = sample("ApiGetAllInstrumentsResponse");
    const lite = refToLite(resp, "ApiGetAllInstrumentsResponse");
    expect(refToFull(lite, "ApiGetAllInstrumentsResponse", problems)).toEqual(resp);
    expect(LITE.toFull(lite, "ApiGetAllInstrumentsResponse")).toEqual(resp);
    expect(problems).toEqual([]);
  });
});

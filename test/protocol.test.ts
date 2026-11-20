// Sans-IO pieces: request table, backoff, frames, decimals, selectors, cookies, redaction.

import { describe, expect, it, vi } from "vitest";
import {
  Backoff,
  jsonrpcFrame,
  parseCookie,
  redact,
  RequestTable,
  TimeCounterClientOrderId,
} from "../src/index.js";

describe("TimeCounterClientOrderId", () => {
  it("wraps the counter without leaving the range", () => {
    const ids = new TimeCounterClientOrderId();
    (ids as unknown as { counter: bigint }).counter = 0x7fffffffn;
    const [a, b] = [BigInt(ids.nextId()), BigInt(ids.nextId())];
    for (const id of [a, b]) expect(id >= 1n << 63n && id < 1n << 64n).toBe(true);
    expect([a & 0x7fffffffn, b & 0x7fffffffn]).toEqual([0x7fffffffn, 0n]);
  });

  it("starts the counter anywhere in its 31 bits", () => {
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(((a: Uint32Array) =>
        a.fill(0xffffffff)) as typeof crypto.getRandomValues);
    try {
      const id = BigInt(new TimeCounterClientOrderId().nextId());
      expect(id & 0x7fffffffn).toBe(0x7fffffffn);
    } finally {
      spy.mockRestore();
    }
  });
});
import { DecimalError, SigningError } from "../src/runtime/errors.js";
import { scaleDecimal, scaled, selector } from "../src/runtime/signing/wire.js";

describe("RequestTable", () => {
  it("skips 0 and ids in use, and counts writes", () => {
    const t = new RequestTable<null>(0xffffffff);
    const a = t.add({ method: "a", write: false, waiter: null });
    const b = t.add({ method: "b", write: true, waiter: null });
    expect([a, b]).toEqual([0xffffffff, 1]);
    expect(t.writesInFlight()).toBe(1);
    expect(t.pop(a)?.method).toBe("a");
    expect(t.pop(a)).toBeUndefined();
    expect(t.drain()).toHaveLength(1);
    expect(t.size).toBe(0);
  });

  it("wraps around pending entries", () => {
    const t = new RequestTable<null>(1);
    t.add({ method: "1", write: false, waiter: null });
    (t as unknown as { nextId: number }).nextId = 1;
    expect(t.add({ method: "2", write: false, waiter: null })).toBe(2);
  });
});

describe("Backoff", () => {
  it("is full jitter and capped", () => {
    let x = 0.37;
    const b = new Backoff(100, 1000, () => (x = (x * 7.13) % 1));
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = b.nextDelayMs();
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(1000, 100 * 2 ** attempt));
    }
    b.reset();
    expect(b.attempt).toBe(0);
  });
});

describe("wire helpers", () => {
  it("embeds params verbatim in a frame", () => {
    expect(jsonrpcFrame("v1/instrument", '{"instrument":"X"}', 7)).toBe(
      '{"jsonrpc":"2.0","method":"v1/instrument","params":{"instrument":"X"},"id":7}',
    );
  });

  it("scales decimals exactly and rejects over-precision", () => {
    expect(scaleDecimal("65000.1", 9)).toBe(65000100000000n);
    expect(scaleDecimal("1.500", 1)).toBe(15n);
    expect(scaleDecimal("0", 9)).toBe(0n);
    expect(scaleDecimal("123456789012345678.123456789", 9)).toBe(123456789012345678123456789n);
    expect(() => scaleDecimal("1.1234567891", 9)).toThrow(/decimal places/);
    expect(() => scaleDecimal("abc", 9)).toThrow(/not a decimal/);
    expect(() => scaleDecimal("1e5", 9)).toThrow(/not a decimal/);
  });

  it("throws a DecimalError that says which refusal it is", () => {
    const thrown = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e;
      }
      throw new Error("did not throw");
    };
    const p = thrown(() => scaleDecimal("1.12345678910", 9)) as DecimalError;
    expect(p).toBeInstanceOf(DecimalError);
    expect(p).toBeInstanceOf(SigningError);
    expect([p.kind, p.value, p.decimals, p.places, p.at]).toEqual([
      "precision",
      "1.12345678910",
      9,
      10,
      undefined,
    ]);
    const m = thrown(() => scaleDecimal("abc", 9)) as DecimalError;
    expect([m.kind, m.value]).toEqual(["malformed", "abc"]);
    const at = thrown(() => scaled("0.5", 0, "OrderLeg.size")) as DecimalError;
    expect([at.kind, at.at, at.message]).toEqual([
      "precision",
      "OrderLeg.size",
      "signing: OrderLeg.size: 0.5 has more than 0 decimal places",
    ]);
  });

  it("builds selectors from the fields that are set", () => {
    expect(selector(["BTC", undefined], [500, 10])).toBe("BTC@500-10");
    expect(selector(["BTC"], [undefined])).toBe("BTC");
    expect(selector(["42", "ETH_USDT_Perp"], [])).toBe("42-ETH_USDT_Perp");
  });

  it("reads the gravity cookie and its expiry", () => {
    expect(
      parseCookie({
        setCookies: ["other=1", "gravity=abc; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT"],
      }),
    ).toEqual({ cookie: "abc", expires: 1445412480 });
    const { expires } = parseCookie({ setCookies: ["gravity=x; Max-Age=60"] });
    expect(expires! - Date.now() / 1000).toBeGreaterThan(55);
    expect(parseCookie({ setCookies: [] })).toEqual({});
  });

  it("redacts secrets in logs", () => {
    const key = "0x" + "ab".repeat(32);
    const out = redact(
      `{"api_key": "k-123", "r":"0x1","order":{"s" : "0x2","size":"1.5"},"pk":"${key}"} gravity=abc; Path=/`,
    );
    expect(out).not.toContain("k-123");
    expect(out).not.toContain("abc;");
    expect(out).not.toContain(key);
    expect(out).toContain('"size":"1.5"');
    expect(out).toContain("gravity=***;");
  });
});

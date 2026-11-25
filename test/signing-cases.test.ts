// Replay every server-produced signing case in sdk/scenarios/signing.json through the GENERATED sign
// functions: byte-equal domain separator, struct hash, digest, typed data, r/s/v, signature object
// and signed request; reject cases must fail before anything is signed.

import { loadShared } from "./shared.js";
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  checkOrder,
  domainSeparator,
  type Domain,
  FixedClock,
  Grvt,
  type Message,
  type OrderIssue,
  OrderOutOfBounds,
  orderIssues,
  PrivateKeySigner,
  type Signature,
  type Signer,
  SigningError,
  signing,
  type StructType,
} from "../src/index.js";

const all = loadShared("scenarios/signing.json");

interface Seen {
  domainSeparator: string;
  structName: string;
  structHash: string;
  digest: string;
  typedData: unknown;
}

/** Captures what the generated code asked to sign, then signs for real. */
class RecordingSigner implements Signer {
  readonly seen: Seen[] = [];
  constructor(private readonly inner: PrivateKeySigner) {}
  get address() {
    return this.inner.address;
  }
  signTyped(domain: Domain, type: StructType, message: Message): Promise<Signature> {
    this.seen.push({
      domainSeparator: bytesToHex(domainSeparator(domain)),
      structName: type.name,
      structHash: bytesToHex(type.hashStruct(message)),
      digest: bytesToHex(type.digest(domain, message)),
      typedData: type.toTypedData(domain, message),
    });
    return this.inner.signTyped(domain, type, message);
  }
}

const SIGN: Record<string, (rt: any, req: any) => Promise<any>> = {
  "order.create_order": signing.signOrderCreateOrder,
  "order.bulk_orders": signing.signOrderBulkOrders,
  "transfer.transfer": signing.signTransferTransfer,
  "transfer.withdrawal": signing.signTransferWithdrawal,
  "edge.wallet_login": signing.signEdgeWalletLogin,
  "vault.vault_invest": signing.signVaultVaultInvest,
  "vault.vault_redeem": signing.signVaultVaultRedeem,
  "vault.vault_burn_tokens": signing.signVaultVaultBurnTokens,
  "position.add_position_margin": signing.signPositionAddPositionMargin,
  "position.set_position_config": signing.signPositionSetPositionConfig,
  "derisk_mm_ratio.set_derisk_mm_ratio": signing.signDeriskMmRatioSetDeriskMmRatio,
};

describe("signing cases", () => {
  it("uses the published test key", () => {
    expect(new PrivateKeySigner(all.test_key.private_key).address).toBe(all.test_key.address);
  });

  it("has a signing case for every signed call", () => {
    expect(new Set(all.cases.map((v: any) => v.rpc))).toEqual(new Set(Object.keys(SIGN)));
    expect(all.cases.length).toBe(20);
  });

  /** A client with the signing case's metadata preloaded; signing reads no network. */
  function caseClient(vec: any): { client: Grvt; signer: RecordingSigner } {
    const signer = new RecordingSigner(new PrivateKeySigner(all.test_key.private_key));
    const client = new Grvt({
      env: "testnet",
      signer,
      clock: new FixedClock(0n),
      http: { post: never, get: never },
    });
    for (const i of vec.inputs.metadata.instruments ?? [])
      client.runtime.metadata.putInstrument(i.instrument, i);
    for (const c of vec.inputs.metadata.currencies ?? [])
      client.runtime.metadata.putCurrency(c.symbol, c);
    if (vec.inputs.metadata.main_account_id)
      client.runtime.metadata.putMainAccount(vec.inputs.metadata.main_account_id);
    return { client, signer };
  }

  function signCase(vec: any): { out: Promise<any>; signer: RecordingSigner } {
    const { client, signer } = caseClient(vec);
    expect(client.runtime.env.chainId).toBe(vec.inputs.env_chain_id);
    const sign = SIGN[vec.rpc];
    expect(sign, `no binding for ${vec.rpc}`).toBeDefined();
    return { out: sign!(client.runtime, structuredClone(vec.inputs.wire_request)), signer };
  }

  for (const vec of all.cases.filter((v: any) => v.expect === "reject")) {
    it(`${vec.name}`, async () => {
      const { out, signer } = signCase(vec);
      await expect(out).rejects.toThrow(SigningError);
      await expect(out).rejects.toThrow(/decimal places/);
      expect(signer.seen).toHaveLength(0); // refused before signing
    });
  }

  // Per-element binding: one signature per list element, in order.
  for (const vec of all.cases.filter((v: any) => v.expect !== "reject" && v.elements)) {
    it(`${vec.name}`, async () => {
      const { out, signer } = signCase(vec);
      const signed = await out;
      expect(signer.seen).toHaveLength(vec.elements.length);
      vec.elements.forEach((el: any, i: number) => {
        const s = signer.seen[i]!;
        expect(s.structName).toBe(el.signed_type);
        expect(s.domainSeparator).toBe(el.steps.domain_separator);
        expect(s.structHash).toBe(el.steps.struct_hash);
        expect(s.digest).toBe(el.steps.digest);
        expect(s.typedData).toEqual(el.steps.typed_data);
        const [, list, index] = /^(\w+)\[(\d+)\]$/.exec(el.path)!;
        const sig = signed[list!][Number(index)].signature;
        expect([sig.r, sig.s, sig.v]).toEqual([el.steps.r, el.steps.s, el.steps.v]);
        expect(sig).toEqual(el.steps.signature);
      });
      expect(signed).toEqual(vec.signed_request);
      expect(JSON.parse(JSON.stringify(signed))).toEqual(vec.signed_request);
    });
  }

  for (const vec of all.cases.filter((v: any) => v.expect !== "reject" && !v.elements)) {
    it(`${vec.name}`, async () => {
      const { out, signer } = signCase(vec);
      const signed = await out;
      const steps = vec.steps;
      const s = signer.seen[0]!;
      expect(s.structName).toBe(vec.signed_type);
      expect(s.domainSeparator).toBe(steps.domain_separator);
      expect(s.structHash).toBe(steps.struct_hash);
      expect(s.digest).toBe(steps.digest);
      expect(s.typedData).toEqual(steps.typed_data);
      const sig = vec.rpc === "order.create_order" ? signed.order.signature : signed.signature;
      expect([sig.r, sig.s, sig.v]).toEqual([steps.r, steps.s, steps.v]);
      expect(sig).toEqual(steps.signature);
      expect(signed).toEqual(steps.signed_request);
      // The request survives JSON exactly as the server expects it.
      expect(JSON.parse(JSON.stringify(signed))).toEqual(steps.signed_request);
    });
  }
});

describe("order checks", () => {
  it("reports independent field failures across legs", () => {
    const order = {
      legs: [
        { instrument: "BTC", size: "invalid", limit_price: "1.15" },
        { instrument: "BTC", size: "1", limit_price: "0.0000000001" },
      ],
    };
    const issues: OrderIssue[] = [
      ...orderIssues(signing.ORDER_CHECKS, order, {
        instrument: () => ({ base_decimals: 9, limits: { tick_size: "0.1" } }),
      }),
    ];
    expect(issues.map(({ leg, field, error }) => [leg, field, error.name])).toEqual([
      [0, "size", "DecimalError"],
      [0, "limit_price", "OrderOutOfBounds"],
      [1, "limit_price", "DecimalError"],
    ]);
  });

  it("checks only fixed-scale fields when orderIssues is called without metadata", () => {
    const order = {
      legs: [{ instrument: "unknown", size: "invalid", limit_price: "0.0000000001" }],
    };
    const issues = [...orderIssues(signing.ORDER_CHECKS, order)];
    expect(issues.map(({ field, error }) => [field, error.name])).toEqual([
      ["limit_price", "DecimalError"],
    ]);
    // @ts-expect-error JavaScript callers can omit this required argument.
    expect(() => checkOrder(signing.ORDER_CHECKS, order)).toThrow(SigningError);
  });

  it("requires supplied metadata to resolve every leg", () => {
    const order = { legs: [{ instrument: "unknown", size: "0.0005", limit_price: "65000.55" }] };
    const missing = { instrument: () => undefined };
    const checks = signing.ORDER_CHECKS;
    for (const check of [
      () => checkOrder(checks, order, missing),
      () => [...orderIssues(checks, order, missing)],
    ]) {
      expect(check).toThrow(SigningError);
      expect(check).toThrow('no metadata for instrument "unknown"');
    }
  });

  it("rejects incomplete or invalid instrument scale from a custom metadata provider", () => {
    const order = { legs: [{ instrument: "X", size: "garbage" }] };
    for (const base_decimals of [undefined, -1, 1.5, NaN]) {
      const meta = { instrument: () => ({ base_decimals: base_decimals as number }) };
      expect(() => checkOrder(signing.ORDER_CHECKS, order, meta)).toThrow(
        'invalid base_decimals for instrument "X"',
      );
    }
  });

  // Every SDK must reach the same verdict, nearest values and message on the shared cases.
  function signOrder(vec: any): { out: Promise<unknown>; signer: RecordingSigner } {
    const signer = new RecordingSigner(new PrivateKeySigner(all.test_key.private_key));
    const client = new Grvt({
      env: "testnet",
      signer,
      clock: new FixedClock(0n),
      http: { post: never, get: never },
    });
    for (const i of vec.instruments) {
      const { instrument_hash, base_decimals, tick_size, min_size, min_notional } = i;
      client.runtime.metadata.putInstrument(i.instrument, {
        instrument_hash,
        base_decimals,
        limits: { tick_size, min_size, min_notional },
      });
    }
    const out = signing.signOrderCreateOrder(client.runtime, {
      order: structuredClone(vec.order),
    });
    return { out, signer };
  }

  const failure = (out: Promise<unknown>) =>
    out.then(
      () => undefined,
      (e) => e,
    );

  for (const vec of all.order_checks.filter((v: any) => v.expect === "pass")) {
    it(`${vec.name}`, async () => {
      const { out, signer } = signOrder(vec);
      await out;
      expect(signer.seen).toHaveLength(1);
    });
  }

  for (const vec of all.order_checks.filter((v: any) => v.expect === "invalid")) {
    it(`${vec.name}`, async () => {
      const { out, signer } = signOrder(vec);
      expect(await failure(out)).toBeInstanceOf(SigningError);
      expect(signer.seen).toHaveLength(0);
    });
  }

  for (const vec of all.order_checks.filter((v: any) => v.expect === "reject")) {
    it(`${vec.name}`, async () => {
      const { out, signer } = signOrder(vec);
      const err = await failure(out);
      expect(signer.seen).toHaveLength(0);
      expect(err).toBeInstanceOf(OrderOutOfBounds);
      const r = vec.rejection;
      expect({ ...err }).toMatchObject({
        instrument: r.instrument,
        leg: r.leg,
        field: r.field,
        check: r.check,
        limit: r.limit,
        value: r.value,
        limitValue: r.limit_value,
        nearest: r.nearest,
        serverCode: r.server_code,
      });
      expect(err.message).toBe(r.message);
    });
  }
});

async function never(): Promise<never> {
  throw new Error("no network in signing case tests");
}

describe("external signer check", () => {
  /** A wallet-style signer that signs with a different key than the address it reports. */
  class WrongKeySigner implements Signer {
    readonly address = new PrivateKeySigner(all.test_key.private_key).address;
    readonly #other = new PrivateKeySigner("0x" + "22".repeat(32));
    async signTyped(domain: Domain, type: StructType, message: Message): Promise<Signature> {
      const s = await this.#other.signTyped(domain, type, message);
      return { ...s, signer: this.address };
    }
  }

  it("rejects a signature that does not recover to the signer address", async () => {
    const vec = all.cases.find((v: any) => v.rpc === "transfer.transfer" && v.expect !== "reject");
    const client = new Grvt({
      env: "testnet",
      signer: new WrongKeySigner(),
      clock: new FixedClock(0n),
      http: { post: never, get: never },
    });
    for (const c of vec.inputs.metadata.currencies ?? [])
      client.runtime.metadata.putCurrency(c.symbol, c);
    const out = signing.signTransferTransfer(
      client.runtime,
      structuredClone(vec.inputs.wire_request),
    );
    await expect(out).rejects.toThrow(SigningError);
    await expect(out).rejects.toThrow(/invalid signature: it recovers to/);
  });
});

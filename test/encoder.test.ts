// The generated encoders (one per signed type) must hash exactly like the reference encoder that
// interprets the type definitions, and refuse the same values with the same messages.

import { loadShared } from "./shared.js";
import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  grvtDomain,
  type Message,
  type MessageValue,
  signing,
  type TypeDefs,
} from "../src/index.js";
import {
  referenceDigest,
  referenceDomainSeparator,
  referenceHashStruct,
} from "./reference/eip712.js";
import { domainSeparator } from "../src/index.js";
import { StructType } from "../src/runtime/signing/eip712.js";

const TYPES = Object.values(signing).filter((v): v is StructType => v instanceof StructType);

// Small deterministic PRNG so failures reproduce.
let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

function randomBits(bits: number): bigint {
  let n = 0n;
  for (let i = 0; i < bits; i += 32) n = (n << 32n) | BigInt(Math.floor(rnd() * 2 ** 32));
  return BigInt.asUintN(bits, n);
}

function intBounds(type: string): { min: bigint; max: bigint } {
  const m = /^(u?)int(\d+)$/.exec(type)!;
  const bits = BigInt(m[2]!);
  return m[1] === "u"
    ? { min: 0n, max: (1n << bits) - 1n }
    : { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n };
}

function randomInt(type: string): bigint {
  const { min, max } = intBounds(type);
  const bits = Number(/\d+$/.exec(type)![0]);
  switch (Math.floor(rnd() * 6)) {
    case 0:
      return min;
    case 1:
      return max;
    case 2:
      return 0n;
    case 3:
      return min < 0n ? -1n - randomBits(Math.floor(rnd() * (bits - 1))) : 1n;
    default:
      return min < 0n ? BigInt.asIntN(bits, randomBits(bits)) : randomBits(Math.ceil(rnd() * bits));
  }
}

function randomAddress(): string {
  const hex = randomBits(160).toString(16).padStart(40, "0");
  const forms = ["0x" + hex, "0x" + hex.toUpperCase(), "0x" + "0".repeat(40)];
  return pick(forms);
}

function randomValue(type: string, types: TypeDefs): MessageValue {
  if (type.endsWith("[]")) {
    const n = pick([0, 1, 2, 3, 5]);
    return Array.from({ length: n }, () => randomValue(type.slice(0, -2), types));
  }
  if (types[type]) return randomMessage(type, types);
  if (type === "bool") return rnd() < 0.5;
  if (type === "address") return randomAddress();
  return randomInt(type);
}

function randomMessage(name: string, types: TypeDefs): Message {
  const out: Message = {};
  for (const f of types[name]!) out[f.name] = randomValue(f.type, types);
  return out;
}

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
  return "no error";
}

/** Every scalar field path in a message: [holder, key, EIP-712 type]. */
function scalarFields(name: string, msg: Message, types: TypeDefs): [Message, string, string][] {
  const out: [Message, string, string][] = [];
  for (const f of types[name]!) {
    const inner = f.type.replace(/\[\]$/, "");
    if (types[inner]) {
      for (const item of msg[f.name] as Message[]) out.push(...scalarFields(inner, item, types));
    } else out.push([msg, f.name, f.type]);
  }
  return out;
}

describe("generated encoders", () => {
  it("covers every signed type", () => {
    const contract = loadShared("contract/contract.json");
    const mapped = contract.signed.types
      .filter((t: { mapping?: object }) => t.mapping && Object.keys(t.mapping).length > 0)
      .map((t: { name: string }) => t.name);
    expect(TYPES.map((t) => t.name).sort()).toEqual(mapped.sort());
  });

  for (const st of TYPES) {
    it(`${st.name}: random messages hash like the reference`, () => {
      for (let i = 0; i < 400; i++) {
        const msg = randomMessage(st.name, st.types);
        const chainId = pick([0n, 1n, 325n, 326n, (1n << 256n) - 1n, randomBits(64)]);
        const domain = grvtDomain(chainId);
        expect(bytesToHex(st.hashStruct(msg))).toBe(bytesToHex(referenceHashStruct(st, msg)));
        expect(bytesToHex(st.digest(domain, msg))).toBe(
          bytesToHex(referenceDigest(domain, st, msg)),
        );
      }
    });

    it(`${st.name}: out-of-range, missing and malformed values fail like the reference`, () => {
      for (let i = 0; i < 60; i++) {
        const msg = randomMessage(st.name, st.types);
        const fields = scalarFields(st.name, msg, st.types);
        const [holder, key, type] = pick(fields);
        const bad: MessageValue[] = [];
        if (type === "address") bad.push("0x12", "not an address");
        else if (type !== "bool") {
          const { min, max } = intBounds(type);
          bad.push(min - 1n, max + 1n, max * 2n + 7n, "12x");
        }
        for (const v of [...bad, undefined]) {
          if (v === undefined) delete holder[key];
          else holder[key] = v;
          const want = failure(() => referenceHashStruct(st, msg));
          expect(failure(() => st.hashStruct(msg))).toBe(want);
          expect(failure(() => st.digest(grvtDomain(1n), msg))).toBe(want);
        }
      }
      const notList = randomMessage(st.name, st.types);
      const lists = st.types[st.name]!.filter((f) => f.type.endsWith("[]"));
      for (const f of lists) notList[f.name] = 5n;
      expect(failure(() => st.hashStruct(notList))).toBe(
        failure(() => referenceHashStruct(st, notList)),
      );
    });
  }

  it("domain separator matches the reference, also for a non-Grvt domain", () => {
    for (const d of [
      grvtDomain(326n),
      grvtDomain(326n),
      { name: "Other", version: "2", chainId: 5n },
    ]) {
      expect(bytesToHex(domainSeparator(d))).toBe(bytesToHex(referenceDomainSeparator(d)));
    }
    const tooBig = grvtDomain(1n << 256n);
    expect(failure(() => domainSeparator(tooBig))).toBe(
      failure(() => referenceDomainSeparator(tooBig)),
    );
  });
});

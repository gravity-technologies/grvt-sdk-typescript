// Reference EIP-712 encoder (test only): interprets the type definitions at runtime. The shipped SDK
// hashes with the encoders generated per signed type; test/encoder.test.ts checks they agree.
// It hashes with @noble/hashes, so it also checks the SDK's own keccak (src/runtime/signing/keccak.ts).

import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  type Domain,
  type Message,
  type MessageValue,
  SigningError,
  type StructType,
  type TypeDefs,
} from "../../src/index.js";
import { hexToBytes } from "../../src/runtime/signing/crypto.js";

const keccak256 = (data: Uint8Array | string): Uint8Array =>
  keccak_256(typeof data === "string" ? new TextEncoder().encode(data) : data);

const DOMAIN_TYPES: TypeDefs = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
};

const baseType = (t: string) => t.replace(/\[\d*\]$/, "");

function deps(primary: string, types: TypeDefs, found = new Set<string>()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const f of types[primary]!) deps(baseType(f.type), types, found);
  return found;
}

function encodeType(primary: string, types: TypeDefs): string {
  const rest = [...deps(primary, types)].filter((x) => x !== primary).sort();
  return [primary, ...rest]
    .map((n) => `${n}(${types[n]!.map((f) => `${f.type} ${f.name}`).join(",")})`)
    .join("");
}

function word(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function encodeValue(
  type: string,
  value: MessageValue | undefined,
  types: TypeDefs,
  at: string,
): Uint8Array {
  if (value === undefined) throw new SigningError(`${at}: missing`);
  if (types[type]) return hashStructWith(type, value as Message, types, at);
  if (type.endsWith("]")) {
    if (!Array.isArray(value)) throw new SigningError(`${at}: not a list`);
    const inner = baseType(type);
    return keccak256(concat(value.map((v, i) => encodeValue(inner, v, types, `${at}[${i}]`))));
  }
  if (type === "string") return keccak256(String(value));
  if (type === "bool") return word(value === true ? 1n : 0n);
  if (type === "address") return word(BigInt(String(value)));
  if (/^bytes\d+$/.test(type)) {
    const out = new Uint8Array(32);
    out.set(hexToBytes(String(value)));
    return out;
  }
  const m = /^(u?)int(\d+)$/.exec(type);
  if (m) {
    const bits = BigInt(m[2]!);
    let n = typeof value === "bigint" ? value : BigInt(value as string);
    if (m[1] === "u") {
      if (n < 0n || n >= 1n << bits) throw new SigningError(`${at}: ${n} does not fit ${type}`);
    } else {
      const lim = 1n << (bits - 1n);
      if (n < -lim || n >= lim) throw new SigningError(`${at}: ${n} does not fit ${type}`);
      if (n < 0n) n += 1n << 256n;
    }
    return word(n);
  }
  throw new SigningError(`${at}: unsupported EIP-712 type ${type}`);
}

function hashStructWith(primary: string, data: Message, types: TypeDefs, at: string): Uint8Array {
  const parts = [keccak256(encodeType(primary, types))];
  for (const f of types[primary]!)
    parts.push(encodeValue(f.type, data[f.name], types, `${at}.${f.name}`));
  return keccak256(concat(parts));
}

export function referenceDomainSeparator(d: Domain): Uint8Array {
  return hashStructWith(
    "EIP712Domain",
    { name: d.name, version: d.version, chainId: d.chainId },
    DOMAIN_TYPES,
    "domain",
  );
}

export function referenceHashStruct(type: StructType, message: Message): Uint8Array {
  return hashStructWith(type.name, message, type.types, type.name);
}

export function referenceDigest(domain: Domain, type: StructType, message: Message): Uint8Array {
  return keccak256(
    concat([
      new Uint8Array([0x19, 0x01]),
      referenceDomainSeparator(domain),
      referenceHashStruct(type, message),
    ]),
  );
}

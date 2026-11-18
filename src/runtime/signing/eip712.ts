// EIP-712 struct types. A StructType is built once per signed type (the generated EIP712_* constants),
// checks the type hash from the contract when it is created, and hashes with the encoder generated for
// that type (src/generated/signing.ts). The domain separator is cached per chain id.

import { SigningError } from "../errors.js";
import { bytesToHex, checksumAddress, keccak256 } from "./crypto.js";
import { putUint256, type StructEncoder, structBuffer } from "./encode.js";

/** EIP-712 field definitions per struct name, e.g. {Order: [{name: "subAccountID", type: "uint64"}, ...]}. */
export type TypeDefs = Readonly<
  Record<string, readonly { readonly name: string; readonly type: string }[]>
>;

/**
 * A message value: bigint for integers, boolean, a 0x string for addresses (and bytesN), a plain
 * string for `string`, an array for T[], an object for a nested struct.
 */
export type MessageValue = bigint | boolean | string | MessageValue[] | Message;
export interface Message {
  [field: string]: MessageValue;
}

/** The Grvt domain has only name, version and chainId. */
export interface Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: bigint;
}

export const DOMAIN_NAME = "GRVT Exchange";
export const DOMAIN_VERSION = "0";
const DOMAIN_TYPES: TypeDefs = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
};

export function grvtDomain(chainId: number | bigint): Domain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: BigInt(chainId) };
}

const baseType = (t: string) => t.replace(/\[\d*\]$/, "");

function deps(primary: string, types: TypeDefs, found = new Set<string>()): Set<string> {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const f of types[primary]!) deps(baseType(f.type), types, found);
  return found;
}

export function encodeType(primary: string, types: TypeDefs): string {
  const rest = [...deps(primary, types)].filter((x) => x !== primary).sort();
  return [primary, ...rest]
    .map((n) => `${n}(${types[n]!.map((f) => `${f.type} ${f.name}`).join(",")})`)
    .join("");
}

function jsonValue(type: string, value: MessageValue, types: TypeDefs): unknown {
  if (types[type]) {
    const msg = value as Message;
    return Object.fromEntries(
      types[type]!.map((f) => [f.name, jsonValue(f.type, msg[f.name]!, types)]),
    );
  }
  if (type.endsWith("]"))
    return (value as MessageValue[]).map((v) => jsonValue(baseType(type), v, types));
  if (type === "address")
    return checksumAddress("0x" + BigInt(String(value)).toString(16).padStart(40, "0"));
  if (/^u?int\d+$/.test(type)) return BigInt(value as bigint).toString();
  return value;
}

const DOMAIN_TYPE_HASH = keccak256(encodeType("EIP712Domain", DOMAIN_TYPES));
const GRVT_NAME_HASH = keccak256(DOMAIN_NAME);
const GRVT_VERSION_HASH = keccak256(DOMAIN_VERSION);
const separators = new Map<bigint, Uint8Array>();

/** The domain separator; the Grvt domain's is computed once per chain id and kept. */
function separator(d: Domain): Uint8Array {
  const grvt = d.name === DOMAIN_NAME && d.version === DOMAIN_VERSION;
  if (grvt) {
    const hit = separators.get(d.chainId);
    if (hit) return hit;
  }
  const { b, v } = structBuffer(4);
  b.set(DOMAIN_TYPE_HASH, 0);
  b.set(grvt ? GRVT_NAME_HASH : keccak256(domainString(d.name, "name")), 32);
  b.set(grvt ? GRVT_VERSION_HASH : keccak256(domainString(d.version, "version")), 64);
  const n = d.chainId;
  putUint256(v, 96, n, "domain", "chainId");
  const out = keccak256(b);
  if (grvt && separators.size < 64) separators.set(n, out);
  return out;
}

function domainString(value: string | undefined, name: string): string {
  if (value === undefined) throw new SigningError(`domain.${name}: missing`);
  return String(value);
}

export function domainSeparator(d: Domain): Uint8Array {
  return separator(d).slice();
}

const DIGEST = new Uint8Array(66);
DIGEST[0] = 0x19;
DIGEST[1] = 0x01;
const DIGEST_STRUCT = DIGEST.subarray(34);

/**
 * One Grvt signed type. Instances are created only by the generated code (src/generated/signing.ts,
 * with its generated encoder); the class is exported from the package as a type only.
 */
export class StructType {
  readonly encoded: string;
  readonly typeHash: string;
  readonly #encode: StructEncoder;

  /** Throws if the computed type hash differs from `expectedTypeHash` (the contract's). */
  constructor(
    readonly name: string,
    readonly types: TypeDefs,
    expectedTypeHash: string,
    encode: StructEncoder,
  ) {
    this.#encode = encode;
    if (!types[name]) throw new Error(`EIP-712 type ${name} has no definition`);
    this.encoded = encodeType(name, types);
    this.typeHash = bytesToHex(keccak256(this.encoded));
    if (expectedTypeHash.toLowerCase() !== this.typeHash) {
      throw new Error(
        `EIP-712 ${name}: type hash ${this.typeHash}, contract says ${expectedTypeHash}`,
      );
    }
  }

  hashStruct(message: Message): Uint8Array {
    const out = new Uint8Array(32);
    this.#encode(message, this.name, out);
    return out;
  }

  digest(domain: Domain, message: Message): Uint8Array {
    DIGEST.set(separator(domain), 2);
    this.#encode(message, this.name, DIGEST_STRUCT);
    return keccak256(DIGEST);
  }

  /** eth_signTypedData_v4 JSON (integers as decimal strings, checksummed addresses). */
  toTypedData(
    domain: Domain,
    message: Message,
  ): {
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    domain: { name: string; version: string; chainId: string };
    message: Record<string, unknown>;
  } {
    const types: Record<string, { name: string; type: string }[]> = {
      EIP712Domain: [...DOMAIN_TYPES.EIP712Domain!],
    };
    for (const n of deps(this.name, this.types)) types[n] = this.types[n]!.map((f) => ({ ...f }));
    return {
      types,
      primaryType: this.name,
      domain: { name: domain.name, version: domain.version, chainId: domain.chainId.toString() },
      message: jsonValue(this.name, message, this.types) as Record<string, unknown>,
    };
  }
}

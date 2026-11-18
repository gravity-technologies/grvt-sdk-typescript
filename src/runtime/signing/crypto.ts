// The only module that imports @noble/* (secp256k1). keccak256 is our own unrolled one (keccak.ts).

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak256Bytes } from "./keccak.js";

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error(`not hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function keccak256(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") return keccak256Bytes(new TextEncoder().encode(data));
  // From plain JS an ArrayBuffer or DataView would otherwise hash as empty input, and a number[] or
  // Uint16Array from its values cut to 8 bits.
  if (!(data instanceof Uint8Array))
    throw new TypeError("keccak256: expected a Uint8Array or a string");
  return keccak256Bytes(data);
}

/** Lowercase 0x address of a private key. */
export function addressOf(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false);
  return bytesToHex(keccak256(pub.slice(1)).slice(12));
}

export function isPrivateKey(key: Uint8Array): boolean {
  return key.length === 32 && secp256k1.utils.isValidPrivateKey(key);
}

let tables = false;

/**
 * A private key ready for repeated signing: the scalar parsed once, and (once per process) a larger
 * fixed-base table for G (window 10: ~35 ms and ~1 MB once, ~15% faster signatures than noble's
 * default window 8).
 */
export function signingKey(privateKey: Uint8Array): bigint {
  if (!tables) {
    secp256k1.Point.BASE.precompute(10, false);
    tables = true;
  }
  return secp256k1.Point.Fn.fromBytes(privateKey);
}

/** Sign a 32-byte digest (deterministic RFC 6979): low-s, v = 27 + recovery id. */
export function signDigest(
  privateKey: Uint8Array | bigint,
  digest: Uint8Array,
): { r: string; s: string; v: number } {
  const sig = secp256k1.sign(digest, privateKey, { lowS: true });
  const pad = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  return { r: pad(sig.r), s: pad(sig.s), v: 27 + sig.recovery };
}

/** EIP-55 mixed-case checksum form of an address. */
export function checksumAddress(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, "");
  const h = bytesToHex(keccak256(a)).slice(2);
  let out = "0x";
  for (let i = 0; i < a.length; i++) out += parseInt(h[i]!, 16) >= 8 ? a[i]!.toUpperCase() : a[i];
  return out;
}

/**
 * Lowercase 0x address that signed `digest` with r/s/v, or undefined if it does not recover (v other than
 * 27 or 28 never does). It only recovers: a high-s signature recovers to the same address as its low-s
 * twin, so use checkSignature to decide whether a signature is valid.
 */
export function recoverAddress(
  digest: Uint8Array,
  r: string,
  s: string,
  v: number,
): string | undefined {
  if (v !== 27 && v !== 28) return undefined;
  try {
    const sig = new secp256k1.Signature(BigInt(r), BigInt(s)).addRecoveryBit(v - 27);
    const pub = sig.recoverPublicKey(digest).toBytes(false);
    return bytesToHex(keccak256(pub.slice(1)).slice(12));
  } catch {
    return undefined;
  }
}

const HALF_ORDER = secp256k1.Point.CURVE().n >> 1n;

/**
 * Why a wallet/KMS signature is not valid for `digest` and `address`, or undefined when it is.
 * The same rule in every SDK: 32-byte r and s, v 27 or 28, low-s, recovers to `address`, and
 * `sig.signer` (when set) is `address`.
 */
export function checkSignature(
  digest: Uint8Array,
  sig: { signer?: string; r: string; s: string; v: number },
  address: string,
): string | undefined {
  const hex32 = /^0x[0-9a-fA-F]{64}$/;
  if (!hex32.test(sig.r) || !hex32.test(sig.s)) return "r and s must be 32 bytes of hex";
  if (sig.v !== 27 && sig.v !== 28) return `v must be 27 or 28, got ${sig.v}`;
  if (BigInt(sig.s) > HALF_ORDER) return "s is not low-s";
  const got = recoverAddress(digest, sig.r, sig.s, sig.v);
  if (got === undefined || got !== address.toLowerCase())
    return `it recovers to ${got ?? "no address"}, not to the signer address (wrong key, or a different message was signed)`;
  if (sig.signer && sig.signer.toLowerCase() !== address.toLowerCase())
    return `its signer field ${sig.signer} is not the signer address`;
  return undefined;
}

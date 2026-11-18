// Writers the generated EIP-712 encoders (src/generated/signing.ts) call. Each generated struct owns
// one preallocated buffer of 32 bytes x (fields + 1); these helpers write one 32-byte word into it.
// Range checks and error messages match the reference encoder (test/reference/eip712.ts) exactly.

import { SigningError } from "../errors.js";
import type { Message, MessageValue } from "./eip712.js";
import { keccak256Into } from "./keccak.js";

/** Writes a struct hash into out[0..32]; `at` is the path used in error messages. */
export type StructEncoder = (message: Message, at: string, out: Uint8Array) => void;

/** A 32-byte constant from 0x hex (type hashes emitted by the generator). */
export function word32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** A struct buffer: 32 bytes x words, with its DataView. */
export function structBuffer(words: number): { b: Uint8Array; v: DataView } {
  const b = new Uint8Array(32 * words);
  return { b, v: new DataView(b.buffer) };
}

/** keccak256(buf) into out[0..32]. */
export function keccakInto(buf: Uint8Array, out: Uint8Array): void {
  keccak256Into(buf, buf.length, out, 0);
}

function present(value: MessageValue | undefined, at: string, name: string): MessageValue {
  if (value === undefined) throw new SigningError(`${at}.${name}: missing`);
  return value;
}

function toBig(value: MessageValue): bigint {
  return typeof value === "bigint" ? value : BigInt(value as string);
}

const U64 = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const U256 = 1n << 256n;

function doesNotFit(at: string, name: string, n: bigint, type: string): SigningError {
  return new SigningError(`${at}.${name}: ${n} does not fit ${type}`);
}

/** bool. */
export function putBool(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  at: string,
  name: string,
): void {
  v.setUint8(off + 31, present(value, at, name) === true ? 1 : 0);
}

/** uint8 .. uint32. */
export function putUint32(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  bits: number,
  at: string,
  name: string,
): void {
  const n = toBig(present(value, at, name));
  if (n < 0n || n >= 1n << BigInt(bits)) throw doesNotFit(at, name, n, `uint${bits}`);
  v.setUint32(off + 28, Number(n));
}

/** int8 .. int32: negative values are written as 256-bit two's complement. */
export function putInt32(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  bits: number,
  at: string,
  name: string,
): void {
  const n = toBig(present(value, at, name));
  const lim = 1n << BigInt(bits - 1);
  if (n < -lim || n >= lim) throw doesNotFit(at, name, n, `int${bits}`);
  if (n < 0n) for (let i = 0; i < 28; i++) v.setUint8(off + i, 0xff);
  v.setInt32(off + 28, Number(n));
}

/** uint64. */
export function putUint64(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  at: string,
  name: string,
): void {
  const n = toBig(present(value, at, name));
  if (n < 0n || n > U64) throw doesNotFit(at, name, n, "uint64");
  v.setBigUint64(off + 24, n);
}

/** int64: negative values are written as 256-bit two's complement. */
export function putInt64(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  at: string,
  name: string,
): void {
  const n = toBig(present(value, at, name));
  if (n < I64_MIN || n > I64_MAX) throw doesNotFit(at, name, n, "int64");
  if (n < 0n) for (let i = 0; i < 24; i++) v.setUint8(off + i, 0xff);
  v.setBigInt64(off + 24, n);
}

function putWord(v: DataView, off: number, n: bigint): void {
  if (n >= 0n && n <= U64) {
    // the common case (asset IDs, chain ids): the value fits the last 8 bytes, the rest are zero
    v.setBigUint64(off, 0n);
    v.setBigUint64(off + 8, 0n);
    v.setBigUint64(off + 16, 0n);
    v.setBigUint64(off + 24, n);
    return;
  }
  let x = n;
  for (let i = 24; i >= 0; i -= 8) {
    v.setBigUint64(off + i, BigInt.asUintN(64, x));
    x >>= 64n;
  }
}

/** uint256. */
export function putUint256(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  at: string,
  name: string,
): void {
  const n = toBig(present(value, at, name));
  if (n < 0n || n >= U256) throw doesNotFit(at, name, n, "uint256");
  putWord(v, off, n);
}

function hexNibble(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** address: a 0x + 40 hex string is parsed in place; anything else as the reference does (BigInt). */
export function putAddress(
  v: DataView,
  off: number,
  value: MessageValue | undefined,
  at: string,
  name: string,
): void {
  const s = present(value, at, name);
  if (typeof s === "string" && s.length === 42 && s[0] === "0" && (s[1] === "x" || s[1] === "X")) {
    let ok = true;
    for (let i = 0; i < 20 && ok; i++) {
      const hi = hexNibble(s.charCodeAt(2 + i * 2));
      const lo = hexNibble(s.charCodeAt(3 + i * 2));
      if (hi < 0 || lo < 0) ok = false;
      else v.setUint8(off + 12 + i, hi * 16 + lo);
    }
    if (ok) return;
  }
  putWord(v, off, BigInt(String(s)));
}

/** T[] of structs: hash every item, then keccak of the item hashes, into out[off..off+32]. */
export function putStructList(
  out: Uint8Array,
  off: number,
  value: MessageValue | undefined,
  at: string,
  name: string,
  item: StructEncoder,
): void {
  const list = present(value, at, name);
  if (!Array.isArray(list)) throw new SigningError(`${at}.${name}: not a list`);
  // one buffer per call: an item may itself hold a list, which re-enters here
  const hashes = new Uint8Array(32 * list.length);
  for (let i = 0; i < list.length; i++) {
    item(list[i] as Message, `${at}.${name}[${i}]`, hashes.subarray(i * 32, i * 32 + 32));
  }
  keccak256Into(hashes, hashes.length, out, off);
}

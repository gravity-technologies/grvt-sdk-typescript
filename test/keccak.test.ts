// The SDK's own keccak256 (src/runtime/signing/keccak.ts) must equal @noble/hashes' for every length
// around the 136-byte block boundaries, and for a prefix of a larger buffer written at an offset.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { expect, it } from "vitest";
import { keccak256 } from "../src/runtime/signing/crypto.js";
import { keccak256Bytes, keccak256Into } from "../src/runtime/signing/keccak.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function bytes(len: number, salt: number): Uint8Array {
  const b = new Uint8Array(len);
  let x = 0x9e3779b9 ^ salt;
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}

it("matches @noble/hashes for 0..700 bytes", () => {
  for (let len = 0; len <= 700; len++) {
    for (const salt of [1, 2]) {
      const data = bytes(len, salt * 1000 + len);
      expect(hex(keccak256Bytes(data)), `length ${len}`).toBe(hex(keccak_256(data)));
    }
  }
  expect(hex(keccak256Bytes(new Uint8Array(0)))).toBe(
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  expect(hex(keccak256Bytes(new Uint8Array(200).fill(0xff)))).toBe(
    hex(keccak_256(new Uint8Array(200).fill(0xff))),
  );
});

it("hashes a prefix of a buffer into an offset of another", () => {
  const data = bytes(400, 7);
  const out = new Uint8Array(80).fill(0xaa);
  keccak256Into(data, 300, out, 40);
  expect(hex(out.subarray(40, 72))).toBe(hex(keccak_256(data.subarray(0, 300))));
  expect(out.subarray(0, 40).every((x) => x === 0xaa)).toBe(true);
  expect(out.subarray(72).every((x) => x === 0xaa)).toBe(true);
});

it("keccak256 hashes bytes and strings and rejects anything else", () => {
  expect(hex(keccak256(new Uint8Array([1, 2, 3])))).toBe(
    hex(keccak_256(new Uint8Array([1, 2, 3]))),
  );
  expect(hex(keccak256(Buffer.from("abc")))).toBe(hex(keccak_256(new TextEncoder().encode("abc"))));
  expect(hex(keccak256("abc"))).toBe(hex(keccak_256(new TextEncoder().encode("abc"))));
  const bad: unknown[] = [
    new ArrayBuffer(10),
    new DataView(new ArrayBuffer(10)),
    [1, 2, 3],
    new Uint16Array(3),
    null,
  ];
  for (const v of bad) expect(() => keccak256(v as Uint8Array)).toThrow(TypeError);
});

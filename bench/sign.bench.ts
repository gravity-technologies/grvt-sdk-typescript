// Order (2 legs): hash only, and hash + sign. Run with `npm run bench`.
// Next to vitest's ops/s it prints the heap allocated per call (measured between forced GCs).

import { bench, describe } from "vitest";
import { grvtDomain, type Message, PrivateKeySigner, signing } from "../src/index.js";
import { signDigest } from "../src/runtime/signing/crypto.js";
import { referenceDigest } from "../test/reference/eip712.js";

const KEY = "0x" + "11".repeat(32);
const signer = new PrivateKeySigner(KEY);
const domain = grvtDomain(326n);
const order: Message = {
  subAccountID: 8289849667772468n,
  isMarket: false,
  timeInForce: 1n,
  postOnly: false,
  reduceOnly: false,
  legs: [
    {
      assetID: 0x030501n,
      contractSize: 1_500_000_000n,
      limitPrice: 65_000_100_000_000n,
      isBuyingContract: true,
    },
    {
      assetID: 0x030502n,
      contractSize: 2_000_000_000n,
      limitPrice: 3_000_000_000_000n,
      isBuyingContract: false,
    },
  ],
  nonce: 1234567n,
  expiration: 1_730_000_000_000_000_000n,
};
const type = signing.EIP712_ORDER;
const OPTS = { time: 3000, warmupTime: 500 };

/** Bytes allocated per call: heap growth over a batch small enough not to trigger a GC. */
function heapPerOp(name: string, fn: () => unknown): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return;
  const n = 200;
  for (let i = 0; i < 2000; i++) fn();
  const samples: number[] = [];
  for (let r = 0; r < 15; r++) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    samples.push((process.memoryUsage().heapUsed - before) / n);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name}: ~${Math.round(samples[7]!)} bytes allocated per call`);
}

const KEY_BYTES = Uint8Array.from(Buffer.from(KEY.slice(2), "hex"));

heapPerOp("hash, generated", () => type.digest(domain, order));
heapPerOp("hash, reference", () => referenceDigest(domain, type, order));
heapPerOp("hash + sign, generated", () => signer.signDigest(type.digest(domain, order)));
heapPerOp("hash + sign, old path", () =>
  signDigest(KEY_BYTES, referenceDigest(domain, type, order)),
);

describe("Order, 2 legs", () => {
  bench(
    "hash: generated encoder",
    () => {
      type.digest(domain, order);
    },
    OPTS,
  );
  bench(
    "hash: reference (old generic) encoder",
    () => {
      referenceDigest(domain, type, order);
    },
    OPTS,
  );
  bench(
    "hash + sign: generated + PrivateKeySigner",
    async () => {
      await signer.signTyped(domain, type, order);
    },
    OPTS,
  );
  bench(
    "hash + sign: old path (generic encoder, key bytes)",
    () => {
      signDigest(KEY_BYTES, referenceDigest(domain, type, order));
    },
    OPTS,
  );
});

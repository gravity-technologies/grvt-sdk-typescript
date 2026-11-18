import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { PrivateKeySigner } from "../src/runtime/signing/signer.js";
import { checkSignature, recoverAddress } from "../src/runtime/signing/crypto.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("checkSignature (same rule in every SDK)", () => {
  const key = new PrivateKeySigner(`0x${"11".repeat(32)}`);
  const digest = new Uint8Array(32).fill(7);
  const good = key.signDigest(digest);

  it("accepts a low-s signature that recovers to the address, signer field optional", () => {
    expect(checkSignature(digest, good, key.address)).toBeUndefined();
    expect(checkSignature(digest, { ...good, signer: "" }, key.address)).toBeUndefined();
  });

  it("rejects high s, a wrong signer field and a different digest", () => {
    const highS = `0x${(N - BigInt(good.s)).toString(16).padStart(64, "0")}`;
    expect(checkSignature(digest, { ...good, s: highS, v: 55 - good.v }, key.address)).toBe(
      "s is not low-s",
    );
    expect(
      checkSignature(digest, { ...good, signer: `0x${"22".repeat(20)}` }, key.address),
    ).toMatch(/signer field/);
    expect(checkSignature(new Uint8Array(32), good, key.address)).toMatch(/it recovers to/);
  });
});

describe("recoverAddress", () => {
  const key = new PrivateKeySigner(`0x${"11".repeat(32)}`);
  const digest = new Uint8Array(32).fill(7);
  const sig = key.signDigest(digest);

  it("returns the signer's lowercase address", () => {
    expect(recoverAddress(digest, sig.r, sig.s, sig.v)).toBe(key.address);
  });

  it("returns another address for another digest or the other v, undefined when it cannot recover", () => {
    const other = recoverAddress(new Uint8Array(32), sig.r, sig.s, sig.v);
    expect(other).toMatch(/^0x[0-9a-f]{40}$/);
    expect(other).not.toBe(key.address);
    expect(recoverAddress(digest, sig.r, sig.s, 55 - sig.v)).not.toBe(key.address);
    expect(recoverAddress(digest, sig.r, sig.s, 0)).toBeUndefined();
    expect(recoverAddress(digest, "0x0", sig.s, sig.v)).toBeUndefined();
  });

  it("rejects v outside 27/28 even where noble would recover (recovery id 2 or 3 with a small r)", () => {
    let r = 1n;
    for (; r < 1000n; r++) {
      try {
        new secp256k1.Signature(r, 5n).addRecoveryBit(2).recoverPublicKey(digest);
        break;
      } catch {
        // this r is not the x of a curve point at recovery id 2
      }
    }
    expect(r).toBeLessThan(1000n);
    const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
    expect(recoverAddress(digest, hex(r), hex(5n), 29)).toBeUndefined();
    for (const v of [0, 1, 26, 30, 35])
      expect(recoverAddress(digest, sig.r, sig.s, v)).toBeUndefined();
  });

  it("only recovers: high s gives the same address, checkSignature is what rejects it", () => {
    const highS = `0x${(N - BigInt(sig.s)).toString(16).padStart(64, "0")}`;
    expect(recoverAddress(digest, sig.r, highS, 55 - sig.v)).toBe(key.address);
    expect(checkSignature(digest, { ...sig, s: highS, v: 55 - sig.v }, key.address)).toBe(
      "s is not low-s",
    );
  });
});

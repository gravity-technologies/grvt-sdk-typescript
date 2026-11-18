// Signer plug-in. A signer gets the exact EIP-712 input (domain, struct type, message) and returns
// r/s/v. It needs no Grvt knowledge: a KMS, HSM or wallet signer can call
// `type.toTypedData(domain, message)` and hand that JSON to its backend (eth_signTypedData_v4).

import { ConfigError } from "../errors.js";
import { addressOf, hexToBytes, isPrivateKey, signDigest, signingKey } from "./crypto.js";
import type { Domain, Message, StructType } from "./eip712.js";

export interface Signature {
  /** 0x-prefixed lowercase address. */
  signer: string;
  /** 0x-prefixed 32-byte hex. */
  r: string;
  /** 0x-prefixed 32-byte hex, low-s (the server rejects high s, code 2007). */
  s: string;
  /** 27 or 28. */
  v: number;
}

export interface Signer {
  /** 0x-prefixed lowercase address. */
  readonly address: string;
  signTyped(domain: Domain, type: StructType, message: Message): Promise<Signature>;
}

/** In-process secp256k1 key (@noble/curves). Also fits session keys. */
export class PrivateKeySigner implements Signer {
  readonly address: string;
  readonly #key: bigint;

  /** `privateKey`: 32 bytes as hex, with or without 0x. */
  constructor(privateKey: string) {
    let key: Uint8Array;
    try {
      key = hexToBytes(privateKey.trim());
    } catch {
      throw new ConfigError("private key is not hex");
    }
    if (!isPrivateKey(key)) throw new ConfigError("bad private key");
    this.#key = signingKey(key);
    this.address = addressOf(key);
  }

  signDigest(digest: Uint8Array): Signature {
    return { signer: this.address, ...signDigest(this.#key, digest) };
  }

  async signTyped(domain: Domain, type: StructType, message: Message): Promise<Signature> {
    return this.signDigest(type.digest(domain, message));
  }

  // never print the key
  toString(): string {
    return `PrivateKeySigner(${this.address})`;
  }
  toJSON(): string {
    return this.toString();
  }
}

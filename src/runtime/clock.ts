// Time, nonces and client order ids. All three are client options so tests can pin them.

import * as behavior from "../generated/behavior.js";

export interface Clock {
  /** Nanoseconds since the Unix epoch. */
  nowNs(): bigint;
}

export interface NonceProvider {
  /** uint32 signature nonce (the EIP-712 nonce is uint32). */
  nextNonce(): number;
}

export interface ClientOrderIdProvider {
  /** A uint64 as a decimal string. */
  nextId(): string;
}

function wallNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/**
 * Local wall clock plus an optional offset to the server clock. `observe(serverMs, rttMs)` (e.g.
 * from GET /time) moves the offset toward the server with exponential smoothing.
 */
export class SystemClock implements Clock {
  private offsetNs = 0n;
  private samples = 0;

  observe(serverMs: number, rttMs: number): void {
    const localMid = wallNs() - BigInt(Math.round((rttMs * 1e6) / 2));
    const sample = BigInt(serverMs) * 1_000_000n - localMid;
    this.offsetNs =
      this.samples === 0
        ? sample
        : BigInt(Math.round(Number(this.offsetNs) * 0.8 + Number(sample) * 0.2));
    this.samples++;
  }

  get offset(): bigint {
    return this.offsetNs;
  }

  nowNs(): bigint {
    return wallNs() + this.offsetNs;
  }
}

/** Always returns the same time. */
export class FixedClock implements Clock {
  constructor(private readonly ns: bigint) {}
  nowNs(): bigint {
    return this.ns;
  }
}

function randomU32(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export class RandomNonce implements NonceProvider {
  nextNonce(): number {
    return randomU32();
  }
}

/**
 * `1 << 63 | seconds << 31 | counter`: unique per process, sortable, and in the API client range [2^63, 2^64).
 * The counter starts at a random 31-bit value, so separate processes rarely collide.
 */
export class TimeCounterClientOrderId implements ClientOrderIdProvider {
  private counter = BigInt(randomU32()) & behavior.CLIENT_ORDER_ID_COUNTER_MASK;

  nextId(): string {
    const seconds = BigInt(Math.floor(Date.now() / 1000)) & behavior.CLIENT_ORDER_ID_SECONDS_MASK;
    const n =
      (1n << 63n) |
      (seconds << BigInt(behavior.CLIENT_ORDER_ID_COUNTER_BITS)) |
      (this.counter & behavior.CLIENT_ORDER_ID_COUNTER_MASK);
    this.counter = (this.counter + 1n) & behavior.CLIENT_ORDER_ID_COUNTER_MASK;
    return n.toString();
  }
}

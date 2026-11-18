/** An exact decimal carried as text. No arithmetic or floating-point conversion is implicit. */
export class Decimal {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
      throw new TypeError("decimal must be a finite base-10 string without an exponent");
    }
    this.#value = value;
    Object.freeze(this);
  }

  toString(): string {
    return this.#value;
  }

  toJSON(): string {
    return this.#value;
  }
}

/** Signed Unix nanoseconds. Date conversion is explicit because Date loses sub-millisecond digits. */
export class Timestamp {
  readonly nanoseconds: bigint;

  constructor(nanoseconds: bigint) {
    if (typeof nanoseconds !== "bigint") throw new TypeError("nanoseconds must be a bigint");
    if (nanoseconds < -(1n << 63n) || nanoseconds >= 1n << 63n) {
      throw new RangeError("timestamp is outside the signed 64-bit range");
    }
    this.nanoseconds = nanoseconds;
    Object.freeze(this);
  }

  /** Round down to the preceding millisecond. */
  toDate(): Date {
    const ns = this.nanoseconds;
    const ms = ns / 1_000_000n - (ns < 0n && ns % 1_000_000n !== 0n ? 1n : 0n);
    return new Date(Number(ms));
  }

  static fromDate(value: Date): Timestamp {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new RangeError("invalid Date");
    return new Timestamp(BigInt(ms) * 1_000_000n);
  }

  toString(): string {
    return this.nanoseconds.toString();
  }

  toJSON(): string {
    return this.toString();
  }
}

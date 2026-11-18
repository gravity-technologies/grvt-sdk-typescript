import type { OrderbookLevel, WSOrderbookLevelsFeedDataV1 } from "./generated/models.js";
import type { GapRange, Event } from "./runtime/hooks.js";
import { Decimal, Timestamp } from "./runtime/scalars.js";

export class BookError extends Error {
  constructor(
    readonly reason: string,
    readonly gap?: GapRange,
  ) {
    super(`order book: ${reason}; reset from a fresh subscription snapshot`);
    this.name = "BookError";
  }
}
export interface BookSnapshot {
  readonly instrument: string;
  readonly sequenceNumber: bigint;
  readonly eventTime: Timestamp;
  readonly bids: readonly Readonly<OrderbookLevel>[];
  readonly asks: readonly Readonly<OrderbookLevel>[];
}
// Positive decimal keys compare exactly without a floating-point conversion.
function priceKey(value: Decimal): string {
  return value
    .toString()
    .replace(/(\.[0-9]*?)0+$/, "$1")
    .replace(/\.$/, "");
}
function compare(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  if (ai!.length !== bi!.length) return ai!.length - bi!.length;
  if (ai !== bi) return ai! < bi! ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const x = af.padEnd(width, "0"),
    y = bf.padEnd(width, "0");
  return x === y ? 0 : x < y ? -1 : 1;
}
function zero(value: Decimal): boolean {
  return /^-?0(?:\.0+)?$/.test(value.toString());
}

/** Feed one SDK subscription, which validates the initial sequence against its
 * acknowledgment. Forward gap events to onEvent. Delta books need a fresh subscription
 * snapshot after a gap. Snapshot mode accepts complete frames after reconnect.
 * This does not recover missed private events. */
export class OrderBook {
  #ready = false;
  #invalidated = false;
  #gap: GapRange | undefined;
  #scope: string | undefined;
  #sequence = 0n;
  #time = new Timestamp(0n);
  #bids = new Map<string, OrderbookLevel>();
  #asks = new Map<string, OrderbookLevel>();
  constructor(
    readonly instrument: string,
    readonly mode: "delta" | "snapshot" = "delta",
  ) {
    if (mode !== "delta" && mode !== "snapshot")
      throw new TypeError("book mode must be delta or snapshot");
  }
  get ready(): boolean {
    return this.#ready;
  }
  get gap(): GapRange | undefined {
    return this.#gap;
  }
  invalidate(gap?: GapRange): void {
    this.#invalidated = true;
    this.#ready = false;
    this.#gap = gap && Object.freeze({ ...gap });
    this.#bids.clear();
    this.#asks.clear();
  }
  #fail(reason: string, gap?: GapRange): never {
    this.invalidate(gap);
    throw new BookError(reason, gap);
  }
  onEvent(event: Event): void {
    if (
      this.mode === "delta" &&
      event.type === "gap" &&
      (this.#scope === undefined || this.#scope === JSON.stringify([event.stream, event.selector]))
    )
      this.invalidate(event.gap);
  }
  /** Reset only with a snapshot from a fresh subscription, not an old queued frame. */
  reset(frame: WSOrderbookLevelsFeedDataV1): void {
    if (this.mode === "delta" && frame.sequence_number !== "0") this.#fail("snapshot_required");
    this.#invalidated = false;
    this.#ready = false;
    this.apply(frame);
  }
  apply(frame: WSOrderbookLevelsFeedDataV1): void {
    if (this.#invalidated) throw new BookError("reset_required", this.#gap);
    const scope = JSON.stringify([frame.stream, frame.selector]);
    if (
      frame.feed.instrument !== this.instrument ||
      (this.#scope !== undefined && this.#scope !== scope)
    )
      this.#fail("wrong_stream");
    const parse = (value: string): bigint => {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) this.#fail("invalid_sequence");
      const parsed = BigInt(value);
      if (parsed >= 1n << 64n) this.#fail("invalid_sequence");
      return parsed;
    };
    const sequence = parse(frame.sequence_number),
      previous = parse(frame.prev_sequence_number);
    if (this.#ready && !(this.mode === "snapshot" && sequence === 0n) && sequence <= this.#sequence)
      this.#fail("out_of_order");
    const snapshot = this.mode === "snapshot" || sequence === 0n;
    if (!snapshot) {
      if (!this.#ready) throw new BookError("not_ready", this.#gap);
      if (this.#sequence !== 0n && previous !== this.#sequence)
        this.#fail("gap", {
          afterSequence: this.#sequence.toString(),
          reason: "sequence_mismatch",
        });
      if (sequence <= this.#sequence || sequence <= previous) this.#fail("out_of_order");
    }
    const bids = frame.feed.bids ?? [],
      asks = frame.feed.asks ?? [];
    for (const level of [...bids, ...asks]) {
      if (
        zero(level.price) ||
        level.price.toString().startsWith("-") ||
        (level.size.toString().startsWith("-") && !zero(level.size))
      )
        this.#fail("invalid_level");
    }
    if (snapshot) {
      this.#bids.clear();
      this.#asks.clear();
    }
    for (const [levels, side] of [
      [bids, this.#bids],
      [asks, this.#asks],
    ] as const) {
      for (const level of levels) {
        const key = priceKey(level.price);
        if (zero(level.size)) side.delete(key);
        else side.set(key, { ...level });
      }
    }
    this.#scope = scope;
    this.#sequence = sequence;
    this.#time = frame.feed.event_time;
    this.#ready = true;
    this.#gap = undefined;
  }
  snapshot(): BookSnapshot {
    if (!this.#ready) throw new BookError("not_ready", this.#gap);
    const sorted = (side: Map<string, OrderbookLevel>, direction: number) =>
      Object.freeze(
        [...side]
          .sort(([a], [b]) => direction * compare(a, b))
          .map(([, v]) => Object.freeze({ ...v })),
      );
    return Object.freeze({
      instrument: this.instrument,
      sequenceNumber: this.#sequence,
      eventTime: this.#time,
      bids: sorted(this.#bids, -1),
      asks: sorted(this.#asks, 1),
    });
  }
}

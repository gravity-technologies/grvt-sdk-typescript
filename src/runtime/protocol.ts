// WebSocket protocol state as plain classes: no sockets, no timers.
//
// - RequestTable: JSON-RPC uint32 id -> pending request
// - Sequencer: per-subscription sequence tracking and gap detection
// - Backoff: full-jitter reconnect and retry delays
//
// Server behaviour this follows:
// - The subscribe reply comes first, then snapshot frames (sequence_number 0), then buffered deltas
//   newer than latest_sequence_number, then live deltas, all in order on one connection.
// - Every delta carries prev_sequence_number; with global sequence numbers the next delta's prev
//   equals the previous delta's number, so a mismatch is a gap.
// - Subscribing again to the same primary selector replaces the old one and sends a fresh snapshot.
// - Seen on testnet: after a re-subscribe on the same socket, the first delta's prev_sequence_number
//   is the OLD last sequence number (what this subscription saw before), not the new subscribe
//   reply's latest_sequence_number. So the first sequenced frame after a (re)subscribe reply is
//   accepted when its prev is 0 or not greater than the latest sequence number known then; after
//   that, prev must equal the last sequence number seen, otherwise it is a gap.

import * as behavior from "../generated/behavior.js";

const UINT32_MAX = 0xffffffff;

export interface Pending<W> {
  method: string;
  write: boolean;
  waiter: W;
}

/** uint32 ids; 0 is never used (the gateway omits id 0 in replies). */
export class RequestTable<W> {
  private nextId: number;
  private readonly pending = new Map<number, Pending<W>>();

  constructor(start = 1) {
    this.nextId = Math.max(1, start);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Store `entry` under a fresh id. Throws only when all 2^32-1 ids are in use. */
  add(entry: Pending<W>): number {
    for (let i = 0; i < UINT32_MAX; i++) {
      const id = this.nextId;
      this.nextId = id >= UINT32_MAX ? 1 : id + 1;
      if (!this.pending.has(id)) {
        this.pending.set(id, entry);
        return id;
      }
    }
    throw new Error("request table full");
  }

  pop(id: number): Pending<W> | undefined {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p;
  }

  drain(): Pending<W>[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }

  writesInFlight(): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.write) n++;
    return n;
  }
}

export type Verdict = "deliver" | "drop" | "gap";

export class Sequencer {
  live = false;
  /** Last sequence number delivered (or the subscribe reply's latest_sequence_number). */
  last = 0n;
  snapshotsLeft = 0;
  gaps = 0;
  /** Set by the caller when it re-subscribes after a gap; cleared when the snapshot arrives. */
  resyncStarted: number | undefined;
  /** The first sequenced frame after a (re)subscribe reply is still to come. */
  private first = false;

  /** Drop every frame until the next subscribe reply. */
  reset(): void {
    this.live = false;
    this.last = 0n;
    this.snapshotsLeft = 0;
  }

  onAck(latestSequenceNumber: bigint, numSnapshots: number): void {
    this.live = true;
    this.last = latestSequenceNumber;
    this.snapshotsLeft = numSnapshots;
    this.first = true;
    if (numSnapshots === 0) this.resyncStarted = undefined;
  }

  onFrame(seq: bigint | undefined, prev: bigint | undefined): Verdict {
    if (!this.live) return "drop";
    if (seq === undefined || seq === 0n) {
      // snapshot (sequence_number 0) or an unsequenced frame
      if (this.snapshotsLeft > 0 && --this.snapshotsLeft === 0) this.resyncStarted = undefined;
      return "deliver";
    }
    if (seq <= this.last) return "drop";
    if (prev !== undefined && prev !== this.last) {
      // The re-subscribe quirk above: `last` is still the reply's latest_sequence_number here.
      const firstOk = this.first && (prev === 0n || prev <= this.last);
      if (!firstOk) {
        this.gaps++;
        this.first = false;
        return "gap";
      }
    }
    this.first = false;
    this.last = seq;
    return "deliver";
  }

  resyncOverdue(nowMs: number, limitMs: number): boolean {
    return this.resyncStarted !== undefined && nowMs - this.resyncStarted > limitMs;
  }
}

/** Full jitter: wait uniform(0, min(cap, base * 2^attempt)). */
export class Backoff {
  attempt = 0;

  constructor(
    readonly baseMs = behavior.RECONNECT_BACKOFF_BASE_MS,
    readonly capMs = behavior.RECONNECT_BACKOFF_CAP_MS,
    private readonly random: () => number = Math.random,
  ) {}

  nextDelayMs(): number {
    const ceiling = Math.min(this.capMs, this.baseMs * 2 ** Math.min(this.attempt, 30));
    this.attempt = Math.min(this.attempt + 1, 30);
    return ceiling * this.random();
  }

  reset(): void {
    this.attempt = 0;
  }
}

/** Build the request text without re-encoding already-encoded params. */
export function jsonrpcFrame(method: string, paramsJson: string, id: number): string {
  return `{"jsonrpc":"2.0","method":${JSON.stringify(method)},"params":${paramsJson},"id":${id}}`;
}

/** A sequence number from a frame ("123", 123 or absent) as a bigint. */
export function seqOf(v: unknown): bigint | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  try {
    return BigInt(v as string | number);
  } catch {
    return undefined;
  }
}

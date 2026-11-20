// User hooks.
//
// - beforeSend(call) runs before signing for every RPC (REST or WS). It may edit call.params in place
//   or return a new params object, but must not add, remove or reorder orders, or change their client order IDs (that throws
//   ConfigError and sends nothing). It runs before signing, so nothing can change a signed request.
// - onEvent(event) is a read-only listener for connection, stream and retry events. It runs on the
//   socket's read path: keep it fast. An exception in it is logged and ignored.
//
// An unset hook costs one check; events are only built when onEvent is set.

import { logError } from "./log.js";

/** One RPC call as beforeSend sees it. */
export interface Call {
  /** e.g. "v1/create_order" */
  readonly rpc: string;
  /** The request as JSON (full wire field names). */
  params: Record<string, unknown>;
  readonly transport: "rest" | "ws";
}

export type SocketName = "md" | "td";

/** Potentially missed sequences: exclusive start, inclusive end; undefined means unknown.
 * An open end includes re-subscription. REST history cannot use these as resume cursors.
 */
export interface GapRange {
  readonly afterSequence?: string;
  readonly throughSequence?: string;
  readonly reason: "sequence_mismatch" | "disconnect" | "overflow";
}

/** What onEvent receives. `type` is the event kind. */
export type Event =
  | { type: "connect"; socket: SocketName }
  | { type: "reconnect"; socket: SocketName }
  | { type: "disconnect"; socket: SocketName; code?: number; reason: string }
  | {
      type: "subscribe";
      socket: SocketName;
      stream: string;
      selector: string;
      latestSequenceNumber: string;
      numSnapshots: number;
    }
  | {
      type: "gap";
      gap: GapRange;
      socket: SocketName;
      stream: string;
      selector: string;
      /** Frame diagnostics exist only for sequence_mismatch. Use gap for recovery bounds. */
      expectedPrev?: string;
      prev?: string;
      seq?: string;
    }
  /** A read retried after delayMs (REST), or a socket reconnect attempt after a failed connect. */
  | {
      type: "retry";
      socket?: SocketName;
      rpc?: string;
      attempt: number;
      delayMs: number;
      error: string;
    }
  /** Raw text as sent or received. NOT redacted. */
  | { type: "frame"; socket: SocketName; direction: "in" | "out"; raw: string }
  | {
      type: "session_rotated";
      generation: number;
      expiresAt: Date;
      websocketReconnectRequired: true;
    }
  | { type: "error"; socket?: SocketName; fatal: boolean; error: string };

export type EventKind = Event["type"];

export type BeforeSend = (call: Call) => void | Record<string, unknown>;
export type OnEvent = (event: Event) => void;

export class Hooks {
  constructor(
    readonly beforeSend?: BeforeSend,
    readonly onEvent?: OnEvent,
  ) {}

  /** Calls onEvent when set. Build the event inside `make` so nothing is allocated when unset. */
  emit(make: () => Event): void {
    const h = this.onEvent;
    if (!h) return;
    try {
      h(make());
    } catch (e) {
      logError("onEvent hook threw", e);
    }
  }
}

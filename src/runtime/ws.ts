// One managed WebSocket per gateway ("md" market data, "td" trading).
//
// What a socket does:
// - connects lazily, with the session cookie + X-Grvt-Account-Id on the handshake when logged in
// - keeps the desired subscriptions and re-sends them after every reconnect
// - JSON-RPC requests: uint32 id -> pending promise, per-request timeout
// - reconnects with full-jitter backoff; stops for good on an auth failure
// - detects sequence gaps and re-subscribes the same selector for a fresh snapshot; escalates to a
//   reconnect if that snapshot does not come within resyncTimeoutMs
// - the read path only parses and routes; it never waits for a consumer: each subscription has a
//   bounded queue of raw frames, and the consumer decodes each one, so a frame that does not decode
//   is a DecodeError in its place in the stream
//
// Browsers cannot set headers on a WebSocket handshake, so an authenticated socket needs Node
// (whose global WebSocket accepts `{ headers }`). Public market data works everywhere.

import type { CallDeadline } from "./deadline.js";
import type { Session } from "./auth.js";
import {
  ApiError,
  type ClientOrderIds,
  ClosedError,
  ConfigError,
  DecodeError,
  ErrorTable,
  FrameTooLarge,
  OrderStateUnknown,
  StreamOverflow,
  TransportError,
} from "./errors.js";
import type { Hooks, SocketName } from "./hooks.js";
import type { LiteCodec } from "./lite.js";
import { debugEnabled, logDebug, logWarn, redact } from "./log.js";
import { Backoff, jsonrpcFrame, RequestTable, seqOf, Sequencer } from "./protocol.js";
import type { StreamSpec } from "./spec.js";

export const CONNECT_TIMEOUT_MS = 10_000;
/** A connection that stayed up this long resets the reconnect backoff. */
const STABLE_AFTER_MS = 10_000;
const WATCHDOG_MS = 500;

/** The part of the WHATWG WebSocket the socket uses. */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  /** `status` is non-standard: a factory that knows the handshake's HTTP status may set it. */
  onclose: ((ev: { code?: number; reason?: string; status?: number }) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

const isNode = () =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  "string";

/** The global WebSocket. Handshake headers (the session) need Node: undici accepts `{ headers }`. */
export const defaultWebSocketFactory: WebSocketFactory = (url, headers) => {
  const WS = (globalThis as { WebSocket?: new (url: string, opts?: unknown) => WebSocketLike })
    .WebSocket;
  if (!WS) throw new ConfigError("no global WebSocket: use Node >= 22 or pass `webSocket`");
  if (Object.keys(headers).length === 0) return new WS(url);
  if (!isNode())
    throw new ConfigError(
      "browsers cannot send the session cookie on a WebSocket handshake; private streams and WS order entry are Node-only",
    );
  return new WS(url, { headers });
};

export interface WsOptions {
  requestTimeoutMs: number;
  resyncTimeoutMs: number;
  maxFrameBytes?: number;
  factory: WebSocketFactory;
  /** Set for encoding "lite": loads the lite names before the first connect. */
  lite?: () => Promise<LiteCodec>;
}

type Waiter =
  | {
      kind: "rpc";
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      clientOrderId?: ClientOrderIds;
      timer?: ReturnType<typeof setTimeout>;
    }
  | { kind: "sub"; sub: Sub }
  | { kind: "ignore" };

const first = (x: unknown) => (Array.isArray(x) ? x[0] : x);
const unref = <T>(t: T): T => ((t as { unref?: () => void })?.unref?.(), t);
const encoder = new TextEncoder();

/** One subscription's state, shared by the socket (producer) and its Subscription (consumer). */
export class Sub {
  readonly seq = new Sequencer();
  private queue: unknown[] = [];
  private head = 0;
  error: Error | undefined;
  closed = false;
  waiter: (() => void) | undefined;
  key: string | undefined;
  ack: { resolve: () => void; reject: (e: Error) => void } | undefined;
  sentEpoch: number | undefined;
  dropped = 0;

  constructor(
    readonly id: number,
    readonly spec: StreamSpec,
    readonly selector: string,
    readonly capacity: number,
  ) {}

  get length(): number {
    return this.queue.length - this.head;
  }

  /** Returns false when the consumer overflowed a stream that may not drop items. */
  push(item: unknown): boolean {
    if (this.length >= this.capacity) {
      if (this.spec.conflate) {
        this.shift();
        this.dropped++;
      } else {
        this.queue = [];
        this.head = 0;
        this.error = new StreamOverflow(this.spec.stream, this.selector, this.capacity);
        this.wake();
        return false;
      }
    }
    this.queue.push(item);
    this.wake();
    return true;
  }

  shift(): unknown {
    const v = this.queue[this.head];
    this.queue[this.head++] = undefined;
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return v;
  }

  fail(err: Error, end: boolean): void {
    if (this.ack) {
      this.ack.reject(err); // the waiting subscribe throws it
      this.ack = undefined;
    } else {
      this.error = err;
    }
    if (end) this.closed = true;
    this.wake();
  }

  end(): void {
    this.closed = true;
    this.ack?.reject(new ClosedError());
    this.ack = undefined;
    this.wake();
  }

  wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
}

type ConnState = "idle" | "down" | "up" | "fatal" | "closed";

export class WsSocket {
  private readonly requests = new RequestTable<Waiter>();
  /** The desired subscriptions, re-sent on every connect. */
  private readonly subs = new Map<number, Sub>();
  /** "stream selector" as the server echoes it -> subscription. */
  private readonly byKey = new Map<string, Sub>();
  private state: ConnState = "idle";
  private fatalError: Error | undefined;
  private ws: WebSocketLike | undefined;
  private epoch: number | undefined;
  private epochs = 0;
  private closing = false;
  private sessionGen = 0;
  private readonly upWaiters = new Set<() => void>();
  private wakeSleep: (() => void) | undefined;
  private endConn: ((reason: string) => void) | undefined;
  private nextSubId = 1;
  /** The lite names once loaded (encoding "lite"); undefined for a full socket. */
  lite: LiteCodec | undefined;

  constructor(
    readonly name: SocketName,
    readonly url: string,
    private readonly session: Session | undefined,
    private readonly hooks: Hooks,
    private readonly errors: ErrorTable,
    readonly opts: WsOptions,
  ) {}

  newSub(spec: StreamSpec, selector: string, capacity: number): Sub {
    return new Sub(this.nextSubId++, spec, selector, Math.max(1, capacity));
  }

  /** Drop the connection and reconnect (subscriptions re-sync from snapshots). */
  forceReconnect(reason: string): void {
    this.endConn?.(reason);
  }

  /** Send one JSON-RPC request and return the parsed `result`. */
  async request(
    method: string,
    paramsJson: string,
    write: boolean,
    timeoutMs?: number,
    clientOrderId?: ClientOrderIds,
    deadline?: CallDeadline,
  ): Promise<unknown> {
    const wait = timeoutMs ?? this.opts.requestTimeoutMs;
    if (!Number.isFinite(wait) || wait <= 0)
      throw new ConfigError("timeoutMs must be finite and positive");
    this.start();
    const connecting = this.waitUp(CONNECT_TIMEOUT_MS);
    const epoch = await (deadline ? deadline.wait(connecting) : connecting);
    deadline?.check(); // failure here: nothing was sent
    if (this.epoch !== epoch) throw new TransportError("socket reconnecting", method, false);
    let dispatched = false;
    let cleanup = () => {};
    const answer = new Promise((resolve, reject) => {
      const waiter: Waiter = { kind: "rpc", resolve, reject, clientOrderId };
      const rid = this.requests.add({ method, write, waiter });
      cleanup = () => {
        this.requests.pop(rid);
        clearTimeout(waiter.timer);
      };
      const text = this.frame(method, paramsJson, rid);
      const limit = this.opts.maxFrameBytes;
      if (limit !== undefined) {
        const size = encoder.encode(text).length;
        if (size > limit) {
          // TODO: fall back to REST once the runtime can tell the RPC is safe to reroute.
          this.requests.pop(rid);
          return reject(new FrameTooLarge(size, limit));
        }
      }
      waiter.timer = setTimeout(() => {
        if (!this.requests.pop(rid)) return;
        const reason = `no reply within ${wait}ms`;
        reject(
          write
            ? new OrderStateUnknown(
                method,
                reason,
                clientOrderId,
                new TransportError(reason, method, true),
              )
            : new TransportError(reason, method, true),
        );
      }, wait);
      deadline?.check();
      const sent = this.sendText(text, deadline);
      if (sent !== "closed") dispatched = true;
      if (sent !== "ok") {
        this.requests.pop(rid);
        clearTimeout(waiter.timer);
        if (sent === "closed") return reject(new TransportError("socket not open", method, false));
        // Part of the frame may have left: a write's outcome is unknown.
        const err = new TransportError("send failed", method, true);
        reject(write ? new OrderStateUnknown(method, err.message, clientOrderId, err) : err);
      }
    });
    try {
      return await (deadline ? deadline.wait(answer) : answer);
    } catch (error) {
      if (write && dispatched && deadline?.signal.aborted)
        throw new OrderStateUnknown(
          method,
          "write cancelled while awaiting its response",
          clientOrderId,
          error,
        );
      throw error;
    } finally {
      cleanup();
    }
  }

  /** Register `sub`, subscribe, and wait for the server's reply. */
  async subscribe(sub: Sub): Promise<void> {
    this.subs.set(sub.id, sub);
    const acked = new Promise<void>((resolve, reject) => (sub.ack = { resolve, reject }));
    acked.catch(() => {});
    try {
      this.start();
      const epoch = await this.waitUp(CONNECT_TIMEOUT_MS);
      // A fresh connect re-sends every desired sub; only send if that did not already happen.
      if (sub.sentEpoch !== epoch && this.epoch === epoch) this.sendSubscribe(sub, epoch);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TransportError(
                `no subscribe reply within ${this.opts.requestTimeoutMs}ms`,
                `subscribe ${sub.spec.stream}`,
                true,
              ),
            ),
          this.opts.requestTimeoutMs,
        );
      });
      try {
        await Promise.race([acked, timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      this.forget(sub);
      sub.ack = undefined;
      throw e;
    }
  }

  unsubscribe(sub: Sub): void {
    this.forget(sub);
    if (this.epoch === undefined) return;
    const rid = this.requests.add({
      method: "unsubscribe",
      write: false,
      waiter: { kind: "ignore" },
    });
    if (this.sendText(this.frame("unsubscribe", this.subParams(sub, true), rid)) !== "ok")
      this.requests.pop(rid);
  }

  /** Close the connection, fail pending requests (writes become OrderStateUnknown), end subscriptions. */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.closing = true;
    this.endConn?.("client closed");
    this.wakeSleep?.();
    this.failPending("client closed");
    for (const s of this.subs.values()) s.end();
    this.subs.clear();
    this.byKey.clear();
    this.state = "closed";
    this.notify();
  }

  // -- connection -----------------------------------------------------------------------------

  private start(): void {
    if (this.state !== "idle") return;
    this.state = "down";
    void this.supervise();
  }

  private notify(): void {
    for (const w of [...this.upWaiters]) w();
  }

  private async waitUp(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.state === "up" && this.epoch !== undefined) return this.epoch;
      if (this.state === "fatal") throw this.fatalError!;
      if (this.state === "closed") throw new ClosedError();
      const left = deadline - Date.now();
      if (left <= 0)
        throw new TransportError(
          `${this.name} socket not connected after ${timeoutMs}ms`,
          undefined,
          false,
        );
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          this.upWaiters.delete(done);
          resolve();
        };
        const t = setTimeout(done, left);
        this.upWaiters.add(done);
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakeSleep = undefined;
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakeSleep = done;
    });
  }

  private async connect(): Promise<WebSocketLike> {
    if (this.opts.lite && !this.lite) this.lite = await this.opts.lite();
    const headers: Record<string, string> = {};
    if (this.session?.enabled) {
      await this.session.ensure();
      Object.assign(headers, this.session.headers());
      this.sessionGen = this.session.generation;
    }
    const ws = this.opts.factory(this.url, headers);
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // not settable on this implementation
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.onopen = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          // already closed
        }
        reject(
          new TransportError(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`, undefined, false),
        );
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {}; // a close event follows
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (ev.status === 401 || ev.status === 403) {
          // Rejected handshake (e.g. sticky-session check): retrying will not help.
          reject(
            new ApiError(
              1000,
              `websocket handshake rejected: ${ev.status}`,
              ev.status,
              undefined,
              false,
            ),
          );
        } else {
          reject(
            new TransportError(`connect failed (close code ${ev.code ?? "-"})`, undefined, false),
          );
        }
      };
    });
  }

  private async supervise(): Promise<void> {
    const backoff = new Backoff();
    let connectedOnce = false;
    while (!this.closing) {
      let ws: WebSocketLike;
      try {
        ws = await this.connect();
      } catch (e) {
        if (this.closing) break;
        const err = e as Error;
        if ((err instanceof ApiError && !err.retryable) || err instanceof ConfigError) {
          this.goFatal(err);
          return;
        }
        const delayMs = backoff.nextDelayMs();
        logDebug(`${this.name} connect failed (${err.message}); retry in ${Math.round(delayMs)}ms`);
        this.hooks.emit(() => ({
          type: "retry",
          socket: this.name,
          attempt: backoff.attempt,
          delayMs,
          error: err.message,
        }));
        await this.sleep(delayMs);
        continue;
      }
      if (this.closing) {
        ws.close(1000);
        break;
      }
      const epoch = ++this.epochs;
      this.ws = ws;
      this.epoch = epoch;
      this.state = "up";
      for (const sub of this.subs.values()) this.sendSubscribe(sub, epoch);
      this.notify();
      const again = connectedOnce;
      this.hooks.emit(() => ({ type: again ? "reconnect" : "connect", socket: this.name }));
      connectedOnce = true;

      const upSince = Date.now();
      const { code, reason } = await this.run(ws);
      if (Date.now() - upSince > STABLE_AFTER_MS) backoff.reset();

      this.ws = undefined;
      this.epoch = undefined;
      if (this.state === "up") this.state = "down";
      this.failPending(`socket closed (${reason}, code ${code ?? "-"})`);
      for (const s of this.subs.values()) {
        if (!this.closing)
          this.hooks.emit(() => ({
            type: "gap",
            socket: this.name,
            stream: s.spec.stream,
            selector: s.selector,
            gap: {
              afterSequence: s.seq.last === 0n ? undefined : s.seq.last.toString(),
              reason: "disconnect",
            },
          }));
        s.seq.reset();
      }
      this.hooks.emit(() => ({ type: "disconnect", socket: this.name, code, reason }));
      if (this.closing) break;
      await this.sleep(backoff.nextDelayMs());
    }
  }

  /** Drive one connection until it ends. Resolves with the close code and why it ended. */
  private run(ws: WebSocketLike): Promise<{ code?: number; reason: string }> {
    return new Promise((resolve) => {
      let done = false;
      const tick = unref(
        setInterval(() => {
          const why = this.watchdog();
          if (why) end(why);
        }, WATCHDOG_MS),
      );
      const finish = (code: number | undefined, reason: string) => {
        if (done) return;
        done = true;
        clearInterval(tick);
        ws.onmessage = ws.onclose = ws.onerror = null;
        if (this.endConn === end) this.endConn = undefined;
        resolve({ code, reason });
      };
      const end = (reason: string) => {
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
        finish(undefined, reason);
      };
      this.endConn = end;
      ws.onmessage = (ev) =>
        this.onFrame(
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer),
        );
      ws.onerror = () => {};
      ws.onclose = (ev) =>
        finish(ev.code, ev.code === 1008 ? "slow consumer (server 1008)" : "closed by server");
    });
  }

  private goFatal(err: Error): void {
    this.state = "fatal";
    this.fatalError = err;
    this.notify();
    this.hooks.emit(() => ({ type: "error", socket: this.name, fatal: true, error: err.message }));
    for (const s of this.subs.values()) s.fail(err, true);
  }

  /** Fail everything still waiting for a reply. Writes become OrderStateUnknown. */
  private failPending(reason: string): void {
    for (const p of this.requests.drain()) {
      const w = p.waiter;
      if (w.kind !== "rpc") continue;
      clearTimeout(w.timer);
      w.reject(
        p.write
          ? new OrderStateUnknown(
              p.method,
              reason,
              w.clientOrderId,
              new TransportError(reason, p.method, true),
            )
          : new TransportError(reason, p.method, true),
      );
    }
  }

  /** "closed": nothing was sent. "failed": the send threw, so part of the frame may have left. */
  private sendText(text: string, deadline?: CallDeadline): "ok" | "closed" | "failed" {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return "closed";
    this.hooks.emit(() => ({ type: "frame", socket: this.name, direction: "out", raw: text }));
    if (debugEnabled()) logDebug(`${this.name} -> ${redact(text)}`);
    deadline?.check();
    try {
      ws.send(text);
      return "ok";
    } catch {
      return "failed";
    }
  }

  private subParams(sub: Sub, unsubscribe: boolean): string {
    const params = {
      stream: sub.spec.stream,
      selectors: [sub.selector],
      use_global_sequence_number: true,
    };
    return this.lite ? this.lite.subParams(unsubscribe, params) : JSON.stringify(params);
  }

  /** A JSON-RPC request in this socket's encoding; params are already encoded. */
  private frame(method: string, paramsJson: string, id: number): string {
    return this.lite
      ? this.lite.frame(method, paramsJson, id)
      : jsonrpcFrame(method, paramsJson, id);
  }

  /** Queue a subscribe for `sub` on connection `epoch`. */
  private sendSubscribe(sub: Sub, epoch: number): void {
    sub.seq.reset(); // drop every frame until the new subscribe reply arrives
    sub.sentEpoch = epoch;
    const rid = this.requests.add({
      method: "subscribe",
      write: false,
      waiter: { kind: "sub", sub },
    });
    if (this.sendText(this.frame("subscribe", this.subParams(sub, false), rid)) !== "ok")
      this.requests.pop(rid);
  }

  private forget(sub: Sub): void {
    this.subs.delete(sub.id);
    if (sub.key && this.byKey.get(sub.key) === sub) this.byKey.delete(sub.key);
    sub.key = undefined;
  }

  // -- incoming (never waits) -----------------------------------------------------------------

  private onFrame(text: string): void {
    this.hooks.emit(() => ({ type: "frame", socket: this.name, direction: "in", raw: text }));
    if (debugEnabled()) logDebug(`${this.name} <- ${redact(text)}`);
    let f: any;
    try {
      f = JSON.parse(text);
    } catch (e) {
      logWarn(`${this.name} undecodable frame dropped: ${(e as Error).message}`);
      return;
    }
    if (!f || typeof f !== "object") return;
    if (this.lite) f = this.lite.inbound(f); // envelope only: result and feed stay lite
    const id = f.id;
    if (id === undefined || id === null) {
      if (typeof f.stream === "string" && typeof f.selector === "string") {
        const sub = this.byKey.get(`${f.stream} ${f.selector}`);
        if (sub) {
          try {
            this.onFeed(sub, f);
          } catch (error) {
            sub.fail(error instanceof Error ? error : new Error(String(error)), false);
          }
        }
      }
      return;
    }
    const p = this.requests.pop(Number(id));
    if (!p) {
      logDebug(`${this.name} reply for unknown id ${id} (late or not ours)`);
      return;
    }
    const w = p.waiter;
    const hasError = Object.hasOwn(f, "error") && f.error !== null;
    if (hasError || (f.code !== undefined && f.result === undefined)) {
      const err = this.errors.responseError(hasError ? f.error : f, undefined, p.method);
      if (w.kind === "rpc") {
        clearTimeout(w.timer);
        w.reject(err);
      } else if (w.kind === "sub") {
        w.sub.fail(err, false);
      }
      return;
    }
    if (w.kind === "rpc") {
      clearTimeout(w.timer);
      w.resolve(f.result ?? null);
    } else if (w.kind === "sub") {
      this.onSubscribeReply(w.sub, this.lite ? this.lite.subscribeResult(f.result) : f.result);
    }
  }

  private onSubscribeReply(sub: Sub, result: any): void {
    // Runs before the snapshot frames that follow the reply.
    if (!this.subs.has(sub.id)) return; // unsubscribed meanwhile
    const canonical =
      typeof first(result?.subs) === "string" ? (first(result.subs) as string) : sub.selector;
    const latest = seqOf(first(result?.latest_sequence_number)) ?? 0n;
    const snaps = Number(first(result?.num_snapshots) ?? 0) || 0;
    const key = `${sub.spec.stream} ${canonical}`;
    if (sub.key && sub.key !== key && this.byKey.get(sub.key) === sub) this.byKey.delete(sub.key);
    sub.key = key;
    this.byKey.set(key, sub);
    sub.seq.onAck(latest, snaps);
    sub.ack?.resolve();
    sub.ack = undefined;
    this.hooks.emit(() => ({
      type: "subscribe",
      socket: this.name,
      stream: sub.spec.stream,
      selector: canonical,
      latestSequenceNumber: latest.toString(),
      numSnapshots: snaps,
    }));
  }

  private onFeed(sub: Sub, f: any): void {
    const seq = seqOf(f.sequence_number);
    const prev = seqOf(f.prev_sequence_number);
    const expected = sub.seq.last;
    switch (sub.seq.onFrame(seq, prev)) {
      case "deliver":
        if (!sub.push(f)) this.resync(sub, "overflow");
        return;
      case "drop":
        return;
      case "gap":
        this.hooks.emit(() => ({
          type: "gap",
          gap: {
            afterSequence: expected.toString(),
            throughSequence:
              sub.spec.snapshotFeed && prev !== undefined && prev >= expected
                ? prev.toString()
                : undefined,
            reason: "sequence_mismatch",
          },
          socket: this.name,
          stream: sub.spec.stream,
          selector: sub.selector,
          expectedPrev: expected.toString(),
          prev: prev?.toString(),
          seq: seq?.toString(),
        }));
        if (sub.spec.snapshotFeed) {
          // every frame is complete; just move on
          if (seq !== undefined) sub.seq.last = seq;
          if (!sub.push(f)) this.resync(sub, "overflow");
        } else {
          this.resync(sub, "gap");
        }
    }
  }

  private resync(sub: Sub, why: string): void {
    if (why === "overflow")
      this.hooks.emit(() => ({
        type: "gap",
        socket: this.name,
        stream: sub.spec.stream,
        selector: sub.selector,
        gap: { reason: "overflow" },
      }));
    logDebug(`${this.name} re-subscribing ${sub.spec.stream} ${sub.selector} after ${why}`);
    sub.seq.resyncStarted = Date.now();
    if (this.epoch !== undefined) this.sendSubscribe(sub, this.epoch);
  }

  /** Why the connection should be dropped now, if at all. */
  private watchdog(): string | undefined {
    const now = Date.now();
    const limit = this.opts.resyncTimeoutMs;
    for (const sub of this.subs.values()) {
      if (sub.seq.resyncOverdue(now, limit)) {
        sub.seq.resyncStarted = undefined;
        return `no snapshot within ${limit}ms of re-subscribe`;
      }
    }
    // Break-before-make: wait for a moment with no writes in flight, then reconnect with
    // the new cookie; subscriptions re-sync from snapshots.
    if (
      this.session?.enabled &&
      this.session.generation !== this.sessionGen &&
      this.requests.writesInFlight() === 0
    ) {
      return "session rotated";
    }
    return undefined;
  }
}

/**
 * A live subscription: an async iterable of feed frames (the whole frame: stream, selector,
 * sequence_number, prev_sequence_number, feed). Iterating subscribes; breaking out of `for await`
 * or calling close() unsubscribes.
 *
 * After a gap, re-subscription requests a fresh snapshot where supported. Older frames can remain
 * queued. A snapshot does not recover missed private events. A StreamOverflow (lossless streams
 * only) is thrown from the iterator; the subscription keeps going, so catch it and iterate again.
 */
export class Subscription<F> implements AsyncIterableIterator<F> {
  private started: Promise<void> | undefined;

  constructor(
    private readonly socket: WsSocket,
    private readonly sub: Sub,
    private readonly beforeSubscribe: () => Promise<void>,
  ) {}

  get stream(): string {
    return this.sub.spec.stream;
  }

  get selector(): string {
    return this.sub.selector;
  }

  /** Items dropped because the consumer was slow (conflating streams only). */
  get dropped(): number {
    return this.sub.dropped;
  }

  /** Subscribe now and wait for the server's reply. Iterating does this on its own. */
  subscribe(): Promise<this> {
    this.started ??= (async () => {
      if (this.sub.closed) throw new ClosedError();
      await this.beforeSubscribe();
      await this.socket.subscribe(this.sub);
    })();
    return this.started.then(() => this);
  }

  async next(): Promise<IteratorResult<F>> {
    try {
      await this.subscribe();
    } catch (e) {
      if (this.sub.closed && this.sub.length === 0) return { value: undefined, done: true };
      throw e;
    }
    for (;;) {
      const sub = this.sub;
      if (sub.error) {
        const e = sub.error;
        sub.error = undefined;
        throw e;
      }
      if (sub.length > 0) {
        let frame = sub.shift();
        try {
          const lite = this.socket.lite;
          if (lite) frame = lite.feed(frame, sub.spec.id);
          if (!sub.spec.decode) return { value: frame as F, done: false };
          return { value: sub.spec.decode(frame) as F, done: false };
        } catch (e) {
          throw new DecodeError(
            `${sub.spec.stream}: cannot decode frame: ${(e as Error).message}`,
            {
              cause: e,
            },
          );
        }
      }
      if (sub.closed) return { value: undefined, done: true };
      await new Promise<void>((resolve) => (sub.waiter = resolve));
    }
  }

  async return(): Promise<IteratorResult<F>> {
    this.close();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Unsubscribe. Safe to call more than once. */
  close(): void {
    const sub = this.sub;
    if (sub.closed) return;
    if (this.started) this.socket.unsubscribe(sub);
    sub.end();
    sub.error = undefined;
  }
}

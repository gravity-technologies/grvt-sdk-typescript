// In-memory fakes for tests: an HTTP transport and a WebSocket gateway that speaks the Grvt WS
// protocol closely enough.
//
// FakeGateway:
// - subscribe -> reply (latest_sequence_number = last pushed for that stream, num_snapshots 1), then
//   one snapshot frame (sequence_number "0"), unless `ignoreSubscribes` > 0
// - unsubscribe -> reply
// - any other method -> {"result": rpcResult(method, params)} unless the method is in ignoreRpcs
// - push() sends a delta to every connection subscribed to that stream + selector; dropAll() closes
//   every connection
//
// Both fakes also speak lite (`{ lite: true }`): they translate at their edge with the reference converter
// (test/reference/lite.ts), keep what they received in full names for the assertions, and record in
// `violations` every key a client sent that is not a lite name, and every gateway call in the wrong
// encoding.

import { feedFixture, responseFixture } from "./fixtures.js";
import {
  feedTypeOf,
  FULL_HTTP_PREFIX,
  LITE_HTTP_PREFIX,
  liteHttpError,
  rpcFor,
  toFull,
  toLite,
} from "./reference/lite.js";

import {
  type Environment,
  type HttpResponse,
  type HttpTransport,
  TransportError,
  type WebSocketFactory,
  type WebSocketLike,
} from "../src/index.js";

export type HttpReply = Partial<HttpResponse> | Error;

/** Client options for a test against the fakes in their default full encoding (the client defaults to lite). */
export const FULL = { encoding: "full" } as const;

export class FakeHttp implements HttpTransport {
  /** Requests as received; for a lite call, `body` is translated to full names and `wire` is as sent. */
  readonly calls: {
    url: string;
    body: string;
    wire: string;
    headers: Record<string, string>;
    at: number;
  }[] = [];
  /** Replies for URLs ending with a key (the full path also matches a lite call), used in order; the last one repeats. */
  readonly routes = new Map<string, HttpReply[]>();
  /** Keys that are not lite names, and calls in the wrong encoding. */
  readonly violations: string[] = [];
  logins = 0;
  readonly lite: boolean;

  constructor(opts: { lite?: boolean } = {}) {
    this.lite = opts.lite ?? false;
    this.routes.set("/auth/api_key/login", [
      {
        status: 200,
        setCookies: ["gravity=cookie-1; Path=/; Max-Age=3600"],
        headers: { "x-grvt-account-id": "acc-1" },
        body: "{}",
      },
    ]);
  }

  on(suffix: string, ...replies: HttpReply[]): this {
    this.routes.set(suffix, replies);
    return this;
  }

  callsTo(suffix: string) {
    return this.calls.filter((c) => fullPath(c.url).endsWith(suffix));
  }

  async post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse> {
    const wire = body;
    const liteCall = url.includes(LITE_HTTP_PREFIX);
    const rpc = rpcFor(url);
    if (rpc && liteCall !== this.lite)
      this.violations.push(`${url}: expected the ${this.lite ? "lite" : "full"} path`);
    if (!rpc && liteCall) this.violations.push(`${url}: has no lite form`);
    if (rpc && liteCall && body !== "") {
      const problems: string[] = [];
      body = JSON.stringify(toFull(JSON.parse(body), rpc.request, problems));
      this.violations.push(...problems);
    }
    this.calls.push({ url, body, wire, headers, at: performance.now() });
    if (url.endsWith("/auth/api_key/login")) this.logins++;
    const reply = (r: HttpResponse): HttpResponse =>
      liteCall && rpc ? liteReply(r, rpc.response) : r;
    for (const [suffix, replies] of this.routes) {
      if (!fullPath(url).endsWith(suffix)) continue;
      const r = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (r instanceof Error) throw r;
      return reply({ status: 200, headers: {}, setCookies: [], body: "{}", ...r });
    }
    return reply({
      status: 200,
      headers: {},
      setCookies: [],
      body: JSON.stringify(responseFixture(fullPath(url))),
    });
  }

  async get(url: string): Promise<HttpResponse> {
    return this.post(url, "", {});
  }
}

const fullPath = (url: string) => url.replace(LITE_HTTP_PREFIX, FULL_HTTP_PREFIX);

/** A full-name reply as the lite server sends it: the RPC response, or the error body. */
function liteReply(r: HttpResponse, responseType: string): HttpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.body);
  } catch {
    return r; // malformed on purpose
  }
  const lite = r.status === 200 ? toLite(parsed, responseType) : liteHttpError(parsed);
  return { ...r, body: JSON.stringify(lite) };
}

export const notSent = () => new TransportError("connection refused", undefined, false);
export const sentNoAnswer = () => new TransportError("no answer within 10ms", undefined, true);

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string; status?: number }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  /** "stream selector" keys this connection subscribed to. */
  readonly subs = new Set<string>();

  constructor(
    private readonly gw: FakeGateway,
    readonly headers: Record<string, string>,
    readonly url = "",
  ) {
    if (url.endsWith("/ws/lite") !== gw.lite)
      gw.violations.push(`${url}: expected the ${gw.lite ? "lite" : "full"} socket`);
    setTimeout(() => {
      if (gw.rejectHandshake) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ code: 1006, status: gw.rejectHandshake });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    const msg = this.gw.lite ? this.gw.fromLite(JSON.parse(data)) : JSON.parse(data);
    this.gw.received.push(msg);
    queueMicrotask(() => this.gw.handle(this, msg));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }

  /** Server -> client, in full names; `resultType` is the reply's result type (lite only). */
  deliver(obj: unknown, resultType?: string): void {
    if (this.readyState !== 1) return;
    const out = this.gw.lite ? toLiteFrame(obj, resultType) : obj;
    queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify(out) }));
  }

  /** Server closes the connection, after the frames it already sent. */
  drop(code = 1006): void {
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code });
    });
  }
}

/** A full-name WS frame as the lite server sends it. */
function toLiteFrame(obj: unknown, resultType?: string): unknown {
  const f = obj as Record<string, unknown>;
  if (f && typeof f === "object" && typeof f.stream === "string" && f.id === undefined) {
    const feedType = feedTypeOf(f.stream);
    return feedType ? toLite(f, feedType) : f;
  }
  const reply = toLite(f, "JSONRPCResponse") as Record<string, unknown>;
  if (resultType && Object.hasOwn(reply, "r")) reply.r = toLite(reply.r, resultType);
  return reply;
}

export class FakeGateway {
  /** Requests as received, in full names (translated when lite). */
  readonly received: any[] = [];
  /** Lite only: requests as the client sent them. */
  readonly wire: any[] = [];
  /** Keys that are not lite names, and sockets in the wrong encoding. */
  readonly violations: string[] = [];
  readonly lite: boolean;

  constructor(opts: { lite?: boolean } = {}) {
    this.lite = opts.lite ?? false;
  }

  readonly conns: FakeSocket[] = [];
  readonly latest = new Map<string, string>();
  ignoreSubscribes = 0;
  /** When set, the next subscribe reply's latest sequence number. */
  ackLatest: string | undefined;
  readonly ignoreRpcs = new Set<string>();
  rejectHandshake: number | undefined;
  rpcResult: (method: string, params: any) => unknown = (method) => responseFixture(method);

  readonly factory: WebSocketFactory = (url, headers) => {
    const s = new FakeSocket(this, headers, url);
    this.conns.push(s);
    return s;
  };

  env(): Environment {
    return {
      name: "fake",
      mdUrl: "http://fake-md",
      tdUrl: "http://fake-td",
      edgeUrl: "http://fake-edge",
      mdWsUrl: "ws://fake/md",
      tdWsUrl: "ws://fake/td",
      mdWsLiteUrl: "ws://fake/md/ws/lite",
      tdWsLiteUrl: "ws://fake/td/ws/lite",
      chainId: 326,
    };
  }

  /** A lite request in full names; keys that are not lite names go to `violations`. */
  fromLite(raw: any): any {
    this.wire.push(raw);
    const problems: string[] = [];
    const msg = toFull(raw, "JSONRPCRequest", problems) as any;
    const params =
      msg.method === "subscribe"
        ? "WSSubscribeParams"
        : msg.method === "unsubscribe"
          ? "WSUnsubscribeParams"
          : rpcFor(msg.method)?.request;
    if (params) msg.params = toFull(msg.params, params, problems, `${msg.method} params`);
    else problems.push(`${msg.method}: unknown method`);
    this.violations.push(...problems);
    return msg;
  }

  subscribes(): any[] {
    return this.received.filter((m) => m.method === "subscribe");
  }

  rpcs(method: string): any[] {
    return this.received.filter((m) => m.method === method);
  }

  handle(conn: FakeSocket, msg: any): void {
    if (msg.method === "subscribe") {
      if (this.ignoreSubscribes > 0) {
        this.ignoreSubscribes--;
        return;
      }
      const { stream, selectors } = msg.params;
      const selector = selectors[0];
      conn.subs.add(`${stream} ${selector}`);
      const latest = this.ackLatest ?? this.latest.get(stream) ?? "0";
      this.ackLatest = undefined;
      conn.deliver(
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            stream,
            subs: [selector],
            unsubs: [],
            num_snapshots: [1],
            first_sequence_number: [latest],
            latest_sequence_number: [latest],
          },
        },
        "WSSubscribeResult",
      );
      conn.deliver({
        stream,
        selector,
        sequence_number: "0",
        prev_sequence_number: "0",
        feed: feedFixture(stream),
      });
      return;
    }
    if (msg.method === "unsubscribe") {
      conn.subs.delete(`${msg.params.stream} ${msg.params.selectors[0]}`);
      conn.deliver({ jsonrpc: "2.0", id: msg.id, result: {} }, "WSUnsubscribeResult");
      return;
    }
    if (this.ignoreRpcs.has(msg.method)) return;
    conn.deliver(
      { jsonrpc: "2.0", id: msg.id, result: this.rpcResult(msg.method, msg.params) },
      rpcFor(msg.method)?.response,
    );
  }

  /** Send a delta to every connection subscribed to stream + selector. */
  push(
    stream: string,
    selector: string,
    seq: number | string,
    prev: number | string,
    ...feed: [unknown?]
  ): void {
    this.latest.set(stream, String(seq));
    for (const c of this.conns) {
      if (c.subs.has(`${stream} ${selector}`))
        c.deliver({
          stream,
          selector,
          sequence_number: String(seq),
          prev_sequence_number: String(prev),
          feed: feed.length ? feed[0] : feedFixture(stream),
        });
    }
  }

  dropAll(code = 1006): void {
    for (const c of this.conns) c.drop(code);
  }

  open(): FakeSocket[] {
    return this.conns.filter((c) => c.readyState === 1);
  }
}

/** Wait until `cond` holds (polling), or fail with `what`. */
export async function waitUntil(
  what: string,
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Take `n` items (or errors) from a subscription. */
export async function take<T>(
  sub: AsyncIterator<T>,
  n: number,
  timeoutMs = 3000,
): Promise<(T | Error)[]> {
  const out: (T | Error)[] = [];
  while (out.length < n) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>(
      (_, rej) =>
        (timer = setTimeout(
          () => rej(new Error(`timed out after ${out.length} items`)),
          timeoutMs,
        )),
    );
    try {
      const r = await Promise.race([sub.next(), timeout]);
      if (r.done) break;
      out.push(r.value);
    } catch (e) {
      if ((e as Error).message.startsWith("timed out")) throw e;
      out.push(e as Error);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

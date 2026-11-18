// The lite wire encoding: the same API with short JSON field names (see RUNTIME_API.md, "Lite encoding").
//
// Lite names are unique only within one type ("s" is a frame's stream, a book level's size and an
// instrument's status), so every rename is per type, driven by the generated table (src/generated/lite.ts).
// The runtime renames at the edges only: requests are built, checked and signed with full names and
// renamed just before they are written; replies and frames are renamed back before the generated decoder
// sees them. Models, hooks, signing and errors never see a lite name.
//
// Unknown keys: on decode they are skipped (the server may send keys the contract does not list); on
// encode they are an error, because the lite server reads a key it does not know as an absent field.

import { ConfigError } from "./errors.js";

/** The generated tables (src/generated/lite.ts). */
export interface LiteTables {
  /** Per type: [full name, lite name, nested type when the field is a type]. */
  readonly types: Readonly<Record<string, readonly (readonly [string, string, string?])[]>>;
  /** Per RPC id: [lite REST path, request type, response type]. */
  readonly rpcs: Readonly<Record<string, readonly [string, string, string]>>;
  /** Per stream id: the type of the frame's feed ("" when the feed is not an object). */
  readonly streams: Readonly<Record<string, string>>;
  /** JSON-RPC request and response types, and the subscribe/unsubscribe params and result types. */
  readonly request: string;
  readonly response: string;
  readonly subscribe: string;
  readonly subscribeResult: string;
  readonly unsubscribe: string;
  /** Lite -> full key of a stream frame's envelope. */
  readonly frame: Readonly<Record<string, string>>;
  /** Lite -> full key of the HTTP error body. */
  readonly httpError: Readonly<Record<string, string>>;
}

/** One direction of one type: incoming key -> [outgoing key, nested type]. */
type Names = Record<string, readonly [string, string | undefined]>;

export class LiteCodec {
  private readonly toFullNames = new Map<string, Names>();
  private readonly toLiteNames = new Map<string, Names>();
  private readonly frameKeys: Names;
  private readonly httpErrorKeys: Names;
  /** Lite keys of the JSON-RPC request: jsonrpc, method, params, id. */
  private readonly req: { jsonrpc: string; method: string; params: string; id: string };
  /** Lite keys the socket checks before renaming a frame. */
  private readonly replyId: string;
  private readonly replyResult: string;
  private readonly replyError: string;
  private readonly httpErrorCode: string;

  constructor(private readonly tables: LiteTables) {
    for (const [type, fields] of Object.entries(tables.types)) {
      const full: Names = Object.create(null);
      const lite: Names = Object.create(null);
      for (const [f, l, nested] of fields) {
        full[l] = [f, nested];
        lite[f] = [l, nested];
      }
      this.toFullNames.set(type, full);
      this.toLiteNames.set(type, lite);
    }
    const flat = (m: Readonly<Record<string, string>>): Names => {
      const out: Names = Object.create(null);
      for (const [l, f] of Object.entries(m)) out[l] = [f, undefined];
      return out;
    };
    this.frameKeys = flat(tables.frame);
    this.httpErrorKeys = flat(tables.httpError);
    const r = this.toLiteNames.get(tables.request);
    const key = (names: Names | undefined, full: string, where: string): string => {
      const k = names?.[full]?.[0];
      if (k === undefined) throw new Error(`lite table: ${where} has no ${full}`);
      return k;
    };
    this.req = {
      jsonrpc: key(r, "jsonrpc", tables.request),
      method: key(r, "method", tables.request),
      params: key(r, "params", tables.request),
      id: key(r, "id", tables.request),
    };
    const resp = this.toLiteNames.get(tables.response);
    this.replyId = key(resp, "id", tables.response);
    this.replyResult = key(resp, "result", tables.response);
    this.replyError = key(resp, "error", tables.response);
    const code = Object.entries(tables.httpError).find(([, f]) => f === "code")?.[0];
    if (code === undefined) throw new Error("lite table: the HTTP error body has no code");
    this.httpErrorCode = code;
  }

  /** Full-name wire value -> lite names, for `type`. Throws ConfigError on a key `type` does not have. */
  toLite(value: unknown, type: string): unknown {
    return rename(value, type, this.toLiteNames, true);
  }

  /** Lite wire value -> full names, for `type`. Unknown keys are skipped. */
  toFull(value: unknown, type: string): unknown {
    return rename(value, type, this.toFullNames, false);
  }

  /** The lite REST path and the request and response types of an RPC. */
  rpc(id: string): readonly [path: string, request: string, response: string] {
    const r = this.tables.rpcs[id];
    if (!r) throw new ConfigError(`${id} has no lite form`);
    return r;
  }

  /** The JSON-RPC request text, params already encoded (lite). */
  frame(method: string, paramsJson: string, id: number): string {
    const k = this.req;
    return `{${JSON.stringify(k.jsonrpc)}:"2.0",${JSON.stringify(k.method)}:${JSON.stringify(method)},${JSON.stringify(k.params)}:${paramsJson},${JSON.stringify(k.id)}:${id}}`;
  }

  /** Subscribe or unsubscribe params, as JSON text. */
  subParams(unsubscribe: boolean, params: Record<string, unknown>): string {
    const t = unsubscribe ? this.tables.unsubscribe : this.tables.subscribe;
    return JSON.stringify(this.toLite(params, t));
  }

  /** The subscribe reply's result with full names. */
  subscribeResult(result: unknown): unknown {
    return this.toFull(result, this.tables.subscribeResult);
  }

  /**
   * A parsed WS frame with its envelope in full names: a REST-style error body (code, message, status, and
   * the reply id when it has one), a reply (id, result, error; `result` stays lite, since its type depends on
   * the request), or a stream frame (`feed` stays lite). The error body comes first: with an id it is still
   * an error, and as a reply its `m` would read as the method and its code and status would be dropped.
   */
  inbound(f: Record<string, unknown>): Record<string, unknown> {
    if (
      Object.hasOwn(f, this.httpErrorCode) &&
      !Object.hasOwn(f, this.replyResult) &&
      !Object.hasOwn(f, this.replyError)
    ) {
      const out = renameWith(f, this.httpErrorKeys);
      if (Object.hasOwn(f, this.replyId)) out.id = f[this.replyId];
      return out;
    }
    if (Object.hasOwn(f, this.replyId))
      return this.toFull(f, this.tables.response) as Record<string, unknown>;
    return renameWith(f, this.frameKeys);
  }

  /** A stream frame from inbound() with its feed renamed for stream `id`. */
  feed(frame: unknown, id: string): unknown {
    const type = this.tables.streams[id];
    if (!type || !frame || typeof frame !== "object") return frame;
    const f = frame as Record<string, unknown>;
    return Object.hasOwn(f, "feed") ? { ...f, feed: this.toFull(f.feed, type) } : f;
  }

  /** An HTTP error body with full names. */
  httpError(body: unknown): unknown {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    return renameWith(body as Record<string, unknown>, this.httpErrorKeys);
  }
}

function renameWith(value: Record<string, unknown>, names: Names): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    const n = names[k];
    if (n !== undefined) out[n[0]] = value[k];
  }
  return out;
}

function rename(value: unknown, type: string, table: Map<string, Names>, strict: boolean): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v: unknown) => rename(v, type, table, strict));
  const names = table.get(type);
  if (names === undefined) throw new ConfigError(`${type} has no lite form`);
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const n = names[k];
    if (n === undefined) {
      if (strict) throw new ConfigError(`lite encoding: ${type} has no field ${JSON.stringify(k)}`);
      continue;
    }
    out[n[0]] = n[1] === undefined ? v[k] : rename(v[k], n[1], table, strict);
  }
  return out;
}

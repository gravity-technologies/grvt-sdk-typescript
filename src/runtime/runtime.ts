import * as behavior from "../generated/behavior.js";
import { CallDeadline } from "./deadline.js";
import { toWire } from "./codec.js";
// The one object a generated client holds. Same size however many RPCs or streams exist.
//
// Generated code calls:
// - rt.call(SPEC, request, options, signFn): one RPC
// - rt.stream(SPEC, selector, options): one subscription
// - in sign functions: rt.call (metadata), rt.metadata, rt.signer, rt.clock, rt.nonces, rt.env,
//   rt.sign (through wire.signInto)

import { LOGIN_PATH, Session } from "./auth.js";
import {
  type ClientOrderIdProvider,
  type Clock,
  type NonceProvider,
  RandomNonce,
  SystemClock,
  TimeCounterClientOrderId,
} from "./clock.js";
import { type Environment, resolveEnv, restUrl, wsUrl } from "./env.js";
import {
  ApiError,
  type ClientOrderIds,
  ConfigError,
  SigningError,
  DecodeError,
  OrderStateUnknown,
  type ErrorInfo,
  ErrorTable,
} from "./errors.js";
import { legInstruments } from "./signing/checks.js";
import { type BeforeSend, Hooks, type OnEvent } from "./hooks.js";
import { FetchTransport, type HttpTransport } from "./http.js";
import type { LiteCodec } from "./lite.js";
import { logWarn } from "./log.js";
import { restCall } from "./rest.js";
import { type Domain, grvtDomain, type Message, type StructType } from "./signing/eip712.js";
import { checkSignature } from "./signing/crypto.js";
import { PrivateKeySigner, type Signature, type Signer } from "./signing/signer.js";
import { type CurrencyMeta, type InstrumentMeta, selector } from "./signing/wire.js";
import type { Gateway, RpcSpec, StreamSpec } from "./spec.js";
import { defaultWebSocketFactory, Subscription, type WebSocketFactory, WsSocket } from "./ws.js";

/** How order-entry writes travel. Chosen once per client. */
export type OrderTransport = "rest" | "ws";

/** The gateways' JSON field names: "lite" (default; short names, smaller frames) or "full". */
export type Encoding = "full" | "lite";

export interface ClientOptions {
  /** Default for omitted request and stream sub-account IDs. Explicit IDs win. */
  subAccountId?: string;
  /** "testnet" (default), "prod", or your own Environment. */
  env?: string | Environment;
  /** Logs in on the first authenticated call. */
  apiKey?: string;
  /** Signs orders, transfers and withdrawals. */
  signer?: Signer;
  /** "rest" (default) or "ws" (lower latency; a drop or timeout is OrderStateUnknown). */
  orderTransport?: OrderTransport;
  /**
   * "lite" (default) or "full". Lite uses short JSON field names on every gateway call and stream
   * (smaller frames). Models, hooks and errors keep full names either way; login always uses full names.
   */
  encoding?: Encoding;
  /** Check each order against its instrument's limits before signing (default true). */
  checkOrders?: boolean;
  clock?: Clock;
  nonces?: NonceProvider;
  clientOrderIds?: ClientOrderIdProvider;
  /** HTTP plug-in (default: global fetch). */
  http?: HttpTransport;
  /** WebSocket plug-in (default: the global WebSocket). */
  webSocket?: WebSocketFactory;
  /** Runs before signing for every RPC; may change the request. */
  beforeSend?: BeforeSend;
  /** Connection, stream and retry events. Keep it fast. */
  onEvent?: OnEvent;
  /** Maximum duration of one HTTP attempt (default 10s). */
  httpAttemptTimeoutMs?: number;
  /** Complete call deadline, including preparation and retries (default 30s). */
  callTimeoutMs?: number;
  /** WS request and subscribe-reply timeout (default 5s). */
  wsRequestTimeoutMs?: number;
  /** Bound on each subscription's queue (default 4096). */
  queueSize?: number;
  /** After a gap re-subscribe, reconnect if no snapshot came within this (default 5s). */
  resyncTimeoutMs?: number;
  /**
   * Drop and reconnect a WebSocket that received no frame at all, not even a ping or pong, for this long
   * (default 30s). Applies only where the WebSocket shows ping frames (see `WebSocketLike.onheartbeat`).
   */
  idleTimeoutMs?: number;
}

/** Per-call options. */
export interface CallOptions {
  /** Bound the complete call, including preparation and retries. */
  timeoutMs?: number;
  /** Native cancellation. A dispatched write becomes OrderStateUnknown. */
  signal?: AbortSignal;
}

/** The generated tables the runtime needs. */
export interface Tables {
  errors: readonly ErrorInfo[];
  environments: Readonly<Record<string, Environment>>;
  /** Loads the lite field names; needed only by clients with encoding "lite". */
  lite?: () => Promise<LiteCodec>;
}

/** A generated sign function: takes the request, returns it signed. */
export type SignFn<R> = (rt: Runtime, req: R) => Promise<R>;

/** `T` with the keys `K` required (used for request types with required fields). */
export type Req<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> };

/**
 * Metadata needed to sign (instrument hash, decimals, the session's main account). Loads once per key;
 * concurrent callers share one load; a failed load is retried next time.
 */
export class MetadataCache {
  private readonly instruments = new Map<string, Promise<InstrumentMeta>>();
  private readonly currencies = new Map<string, Promise<CurrencyMeta>>();
  private readonly session = new Map<string, Promise<string>>();

  instrument(name: string, load: () => Promise<InstrumentMeta>): Promise<InstrumentMeta> {
    return cached(this.instruments, name, load);
  }

  currency(symbol: string, load: () => Promise<CurrencyMeta>): Promise<CurrencyMeta> {
    return cached(this.currencies, symbol, load);
  }

  /** The session's main account address (contract signed.main_account). */
  mainAccount(load: () => Promise<string>): Promise<string> {
    return cached(this.session, "main_account", load);
  }

  putMainAccount(address: string): void {
    this.session.set("main_account", Promise.resolve(address));
  }

  putInstrument(name: string, meta: InstrumentMeta): void {
    this.instruments.set(name, Promise.resolve(meta));
  }

  /** Forget an instrument; the next call that needs it loads it again. */
  dropInstrument(name: string): void {
    this.instruments.delete(name);
  }

  putCurrency(symbol: string, meta: CurrencyMeta): void {
    this.currencies.set(symbol, Promise.resolve(meta));
  }
}

function cached<T>(m: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = m.get(key);
  if (!p) {
    p = load();
    m.set(key, p);
    const mine = p;
    p.catch(() => m.get(key) === mine && m.delete(key));
  }
  return p;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_TIMER_MS = 2 ** 31 - 1;

export class Runtime {
  readonly env: Environment;
  readonly signer: Signer | undefined;
  readonly orderTransport: OrderTransport;
  readonly encoding: Encoding;
  readonly subAccountId: string | undefined;
  readonly checkOrders: boolean;
  readonly clock: Clock;
  readonly nonces: NonceProvider;
  readonly clientOrderIds: ClientOrderIdProvider;
  readonly http: HttpTransport;
  readonly hooks: Hooks;
  readonly errors: ErrorTable;
  readonly metadata = new MetadataCache();
  readonly session: Session;
  /** The EIP-712 domain for this environment's chain id. */
  readonly domain: Domain;
  readonly md: WsSocket;
  readonly td: WsSocket;
  private readonly httpAttemptTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly lifetime = new AbortController();
  private readonly queueSize: number;
  /** The lite field names, loaded on first use; undefined for a full client. */
  private readonly lite: (() => Promise<LiteCodec>) | undefined;
  /** The wait after a failed session renewal. */
  private readonly sessionRetryDelayMs = behavior.SESSION_RETRY_DELAY_MS;
  private rotation: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(options: ClientOptions, tables: Tables) {
    this.env = resolveEnv(
      options.env ?? "testnet",
      tables.environments,
      (options.encoding ?? "lite") === "lite",
    );
    this.subAccountId = this.account(options.subAccountId);
    this.signer = options.signer;
    this.orderTransport = options.orderTransport ?? "rest";
    if (this.orderTransport !== "rest" && this.orderTransport !== "ws")
      throw new ConfigError(`orderTransport must be "rest" or "ws"`);
    this.encoding = options.encoding ?? "lite";
    if (this.encoding !== "full" && this.encoding !== "lite")
      throw new ConfigError(`encoding must be "full" or "lite"`);
    if (this.encoding === "lite") {
      const load = tables.lite;
      if (!load) throw new ConfigError(`encoding "lite" needs the generated lite tables`);
      let loaded: Promise<LiteCodec> | undefined;
      this.lite = () => {
        if (!loaded) {
          const p = load();
          loaded = p;
          p.catch(() => loaded === p && (loaded = undefined)); // a failed load is retried next time
        }
        return loaded;
      };
    }
    this.checkOrders = options.checkOrders ?? true;
    this.clock = options.clock ?? new SystemClock();
    this.nonces = options.nonces ?? new RandomNonce();
    this.clientOrderIds = options.clientOrderIds ?? new TimeCounterClientOrderId();
    this.http = options.http ?? new FetchTransport();
    this.hooks = new Hooks(options.beforeSend, options.onEvent);
    this.errors = new ErrorTable(tables.errors);
    this.httpAttemptTimeoutMs = options.httpAttemptTimeoutMs ?? behavior.HTTP_ATTEMPT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? behavior.CALL_TIMEOUT_MS;
    for (const value of [
      this.httpAttemptTimeoutMs,
      this.callTimeoutMs,
      options.wsRequestTimeoutMs ?? behavior.WS_REQUEST_TIMEOUT_MS,
      options.resyncTimeoutMs ?? behavior.RESYNC_TIMEOUT_MS,
      options.idleTimeoutMs ?? behavior.WS_IDLE_TIMEOUT_MS,
    ])
      if (!Number.isFinite(value) || value <= 0)
        throw new ConfigError("timeouts must be finite and positive");
    this.queueSize = options.queueSize ?? behavior.QUEUE_SIZE;
    if (!Number.isInteger(this.queueSize) || this.queueSize < behavior.QUEUE_SIZE_MIN)
      throw new ConfigError(`queueSize must be an integer of at least ${behavior.QUEUE_SIZE_MIN}`);
    this.session = new Session(
      options.apiKey,
      this.env.edgeUrl + LOGIN_PATH,
      this.http,
      this.httpAttemptTimeoutMs,
      this.lifetime.signal,
    );
    this.domain = grvtDomain(this.env.chainId);
    const wsOpts = {
      requestTimeoutMs: options.wsRequestTimeoutMs ?? behavior.WS_REQUEST_TIMEOUT_MS,
      resyncTimeoutMs: options.resyncTimeoutMs ?? behavior.RESYNC_TIMEOUT_MS,
      idleTimeoutMs: options.idleTimeoutMs ?? behavior.WS_IDLE_TIMEOUT_MS,
      maxFrameBytes: this.env.wsMaxFrameBytes,
      factory: options.webSocket ?? defaultWebSocketFactory,
      lite: this.lite,
    };
    this.md = new WsSocket(
      "md",
      wsUrl(this.env, "md", this.lite !== undefined),
      this.session,
      this.hooks,
      this.errors,
      wsOpts,
    );
    this.td = new WsSocket(
      "td",
      wsUrl(this.env, "td", this.lite !== undefined),
      this.session,
      this.hooks,
      this.errors,
      wsOpts,
    );
  }

  /** The managed socket for a gateway. */
  socket(gateway: Gateway): WsSocket {
    return gateway === "md" ? this.md : this.td;
  }

  /** Close both sockets and stop background timers. Pending writes become OrderStateUnknown. */
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new DOMException("client closed", "AbortError"));
    clearTimeout(this.rotation);
    await Promise.all([this.md.close(), this.td.close()]);
  }

  // -- RPC ----------------------------------------------------------------------------------

  private account(value: unknown): string | undefined {
    if (value === undefined || value === null) return this.subAccountId;
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw new ConfigError("sub_account_id must be an exact integer");
    const text = String(value);
    if (!/^[0-9]+$/.test(text) || BigInt(text) <= 0n || BigInt(text) > 18446744073709551615n)
      throw new ConfigError("sub_account_id must be a positive uint64");
    return BigInt(text).toString();
  }

  /** One RPC: required fields -> client_order_id -> beforeSend -> sign -> encode -> REST or WS -> decode. */
  async call<Resp>(
    spec: RpcSpec,
    req: object | undefined,
    options?: CallOptions,
    sign?: SignFn<any>,
  ): Promise<Resp> {
    const deadline = new CallDeadline(options?.timeoutMs ?? this.callTimeoutMs, [
      this.lifetime.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
    try {
      return await this.executeCall<Resp>(spec, req, deadline, sign);
    } finally {
      deadline.close();
    }
  }

  private async executeCall<Resp>(
    spec: RpcSpec,
    req: object | undefined,
    deadline: CallDeadline,
    sign?: SignFn<any>,
  ): Promise<Resp> {
    deadline.check();
    const given = { ...(req ?? {}) } as Record<string, unknown>;
    if (spec.defaultSubAccount) given.sub_account_id = this.account(given.sub_account_id);
    if (spec.clientOrderId) {
      const account = given.sub_account_id ?? this.subAccountId;
      const fill = (order: object) => {
        const value = order as Record<string, unknown>;
        const id = this.account(value.sub_account_id ?? account);
        if (id === undefined)
          throw new ConfigError(
            "order.sub_account_id is required when no client default is configured",
          );
        return { ...value, sub_account_id: id };
      };
      if (spec.clientOrderId === "order" && given.order) given.order = fill(given.order as object);
      if (spec.clientOrderId === "orders" && Array.isArray(given.orders))
        given.orders = given.orders.map(fill);
    }
    for (const f of spec.required) {
      if (given[f] === undefined || given[f] === null)
        throw new ConfigError(`${spec.method}: ${f} is required`);
    }
    let params = (spec.encode ? spec.encode(given) : toWire(given)) as Record<string, unknown>;
    const field = spec.clientOrderId;
    const clientOrderId = field ? this.fillClientOrderId(params, field) : undefined;
    const via = spec.orderEntry && this.orderTransport === "ws" ? "ws" : "rest";
    const hook = this.hooks.beforeSend;
    if (hook) {
      const call = { rpc: spec.method, params, transport: via } as const;
      const out = hook(call);
      params = out && typeof out === "object" ? out : call.params;
      // The IDs are how an unknown outcome is looked up, so they must be the ones the caller knows.
      // An id the hook removed is filled again with a new one, which fails here too.
      if (
        field &&
        JSON.stringify(this.fillClientOrderId(params, field)) !== JSON.stringify(clientOrderId)
      )
        throw new ConfigError(
          `${spec.method}: beforeSend must not add, remove or reorder orders, or change their client order IDs`,
        );
    }
    deadline.check();
    if (sign) params = await deadline.wait(sign(this, params)); // nothing may change the request after this line
    deadline.check();
    let body = JSON.stringify(params);
    // Lite: the same request with lite names (the edge has no lite form).
    let lite: { codec: LiteCodec; path: string; response: string } | undefined;
    if (this.lite && spec.gateway !== "edge") {
      const codec = await deadline.wait(this.lite());
      deadline.check();
      const [path, request, response] = codec.rpc(spec.id);
      body = JSON.stringify(codec.toLite(JSON.parse(body), request));
      lite = { codec, path, response };
    }
    try {
      let response: unknown = await this.send<Resp>(spec, via, body, deadline, clientOrderId, lite);
      try {
        if (!response || typeof response !== "object" || Array.isArray(response))
          throw new DecodeError(spec.method, "expected a response object");
        if (lite) response = lite.codec.toFull(response, lite.response);
        return (spec.decode ? spec.decode(response) : response) as Resp;
      } catch (e) {
        // The generated decoder throws a plain TypeError for a reply of the wrong shape.
        const error =
          e instanceof DecodeError
            ? e
            : new DecodeError(spec.method, `cannot decode response: ${(e as Error).message}`, {
                cause: e,
              });
        if (spec.write)
          throw new OrderStateUnknown(spec.method, String(error), clientOrderId, error);
        throw error;
      }
    } catch (e) {
      if (e instanceof ApiError && spec.refreshMetadataOn?.includes(e.code)) {
        for (const name of legInstruments(params)) this.metadata.dropInstrument(name);
      }
      throw e;
    }
  }

  private async send<Resp>(
    spec: RpcSpec,
    via: "ws" | "rest",
    body: string,
    deadline: CallDeadline,
    clientOrderId: ClientOrderIds,
    lite?: { codec: LiteCodec; path: string },
  ): Promise<Resp> {
    deadline.check();
    if (spec.auth) await deadline.wait(this.ensureSession());
    deadline.check();
    if (via === "ws") {
      try {
        return (await this.td.request(
          spec.method,
          body,
          spec.write,
          undefined,
          clientOrderId,
          deadline,
        )) as Resp;
      } catch (e) {
        if (spec.write && e instanceof ApiError && this.errors.uncertain(e))
          throw new OrderStateUnknown(spec.method, e.message, clientOrderId, e);
        throw e;
      }
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (spec.auth) Object.assign(headers, this.session.headers());
    const text = await restCall({
      http: this.http,
      url: restUrl(this.env, spec.gateway, lite ? lite.path : spec.path),
      spec,
      body,
      headers,
      timeoutMs: this.httpAttemptTimeoutMs,
      deadline,
      hooks: this.hooks,
      errors: this.errors,
      clientOrderId,
      sleep,
      errorBody: lite ? (b) => lite.codec.httpError(b) : undefined,
    });
    try {
      return JSON.parse(text) as Resp;
    } catch (e) {
      const error = new DecodeError(
        spec.method,
        `cannot decode response: ${(e as Error).message}`,
        { cause: e },
      );
      if (spec.write) throw new OrderStateUnknown(spec.method, error.message, clientOrderId, error);
      throw error;
    }
  }

  /**
   * Order writes: set metadata.client_order_id when absent on params[field] (one Order, or each Order of a
   * list) and return the id(s).
   */
  private fillClientOrderId(params: Record<string, unknown>, field: string): ClientOrderIds {
    type O = { metadata?: { client_order_id?: string } };
    const fill = (order: O): string => {
      order.metadata ??= {};
      const id = order.metadata.client_order_id;
      if (id === undefined || id === null || String(id) === "" || String(id) === "0")
        order.metadata.client_order_id = this.clientOrderIds.nextId();
      return String(order.metadata.client_order_id);
    };
    const v = params[field];
    if (Array.isArray(v)) return v.filter((o): o is O => !!o && typeof o === "object").map(fill);
    if (!v || typeof v !== "object") return undefined;
    return fill(v as O);
  }

  // -- streams ------------------------------------------------------------------------------

  /** A subscription for `selector` (wire field names). Nothing is sent until it is iterated. */
  stream<F>(spec: StreamSpec, sel: Record<string, unknown> | undefined): Subscription<F> {
    const s = { ...(sel ?? {}) };
    if (spec.primary.some((f) => f.name === "sub_account_id" && f.required))
      s.sub_account_id = this.account(s.sub_account_id);
    const pick = (fields: StreamSpec["primary"]) =>
      fields.map((f) => {
        const v = s[f.name];
        if (f.required && (v === undefined || v === null || v === ""))
          throw new ConfigError(`${spec.stream}: ${f.name} is required`);
        return v;
      });
    const text = selector(pick(spec.primary), pick(spec.secondary));
    const socket = this.socket(spec.gateway);
    const sub = socket.newSub(spec, text, this.queueSize);
    return new Subscription<F>(socket, sub, async () => {
      if (spec.auth) await this.ensureSession();
    });
  }

  // -- signing ------------------------------------------------------------------------------

  /** Sign with the Grvt domain for `chainId` (default: this environment's chain id). */
  async sign(type: StructType, message: Message, chainId?: bigint): Promise<Signature> {
    if (!this.signer)
      throw new ConfigError("this call needs a signer: pass `signer` to the client");
    const domain =
      chainId !== undefined && chainId !== this.domain.chainId ? grvtDomain(chainId) : this.domain;
    const signer = this.signer;
    // Exact class only: a subclass may override signTyped, so it is checked like any other signer.
    if (signer.constructor === PrivateKeySigner)
      return (signer as PrivateKeySigner).signDigest(type.digest(domain, message));
    // An external (wallet/KMS) signer hashed the typed data itself: check it signed our digest.
    const sig = await signer.signTyped(domain, type, message);
    const why = checkSignature(type.digest(domain, message), sig, signer.address);
    if (why !== undefined)
      throw new SigningError(`signer ${signer.address} returned an invalid signature: ${why}`);
    return sig;
  }

  // -- session ------------------------------------------------------------------------------

  async ensureSession(): Promise<void> {
    if (!this.session.enabled)
      throw new ConfigError("this call needs a session: pass `apiKey` to the client");
    await this.session.ensure();
    this.scheduleRotation(0);
  }

  private scheduleRotation(minMs: number): void {
    if (this.rotation !== undefined || this.closed) return;
    const due = Math.max(
      minMs,
      behavior.SESSION_RENEW_MIN_WAIT_MS,
      (this.session.refreshDue - Date.now() / 1000) * 1000,
    );
    this.rotation = setTimeout(
      async () => {
        let retryMs = 0;
        try {
          await this.session.login();
          const s = this.session;
          this.hooks.emit(() => ({
            type: "session_rotated",
            websocketReconnectRequired: true,
            generation: s.generation,
            expiresAt: new Date(s.expiresAt * 1000),
          }));
        } catch (e) {
          logWarn(`session re-login failed: ${(e as Error).message}`);
          this.hooks.emit(() => ({
            type: "error",
            fatal: false,
            error: `session: ${(e as Error).message}`,
          }));
          retryMs = this.sessionRetryDelayMs;
        }
        this.rotation = undefined;
        this.scheduleRotation(retryMs);
      },
      Math.min(due, MAX_TIMER_MS),
    );
    (this.rotation as { unref?: () => void }).unref?.();
  }

  // -- clock --------------------------------------------------------------------------------

  /** GET {md}/time ({"server_time": ms}) and feed it to `clock`. */
  async syncClock(clock: SystemClock): Promise<void> {
    const t0 = Date.now();
    const resp = await this.http.get(`${this.env.mdUrl}/time`, this.httpAttemptTimeoutMs);
    const rtt = Date.now() - t0;
    if (resp.status !== 200) return;
    try {
      const ms = Number(JSON.parse(resp.body)?.server_time);
      if (Number.isFinite(ms) && ms > 0) clock.observe(ms, rtt);
    } catch {
      // not JSON
    }
  }
}

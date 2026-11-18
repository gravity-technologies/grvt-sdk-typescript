// Errors thrown by the SDK. All extend GrvtError.
//
// - ApiError: the server answered with an error code (RateLimitError for code 1006).
// - TransportError: no usable answer (connect failure, timeout on a read, socket closed).
// - OrderStateUnknown: a write may or may not have reached the exchange. Never resend blindly:
//   look the order up by clientOrderId first.
// - StreamOverflow: a consumer fell behind a stream that may not drop items.
// - OrderOutOfBounds: an order leg breaks its instrument's tick, size step, minimum size or minimum
//   notional. Thrown before signing; nothing was sent.

import * as behavior from "../generated/behavior.js";

/** One row of the contract's error table. The generated ERRORS list holds all of them. */
export interface ErrorInfo {
  code: number;
  name: string;
  status: number;
  message: string;
  retryable: boolean;
}

/** The rate-limit code. Always retryable for reads. */
export const RATE_LIMIT_CODE = behavior.RATE_LIMIT_CODE;

export class GrvtError extends Error {
  override name = "GrvtError";
}

export class ApiError extends GrvtError {
  override name = "ApiError";
  constructor(
    readonly code: number,
    message: string,
    readonly status: number | undefined,
    readonly rpc: string | undefined,
    readonly retryable: boolean,
  ) {
    super(`${rpc ?? "?"}: [${code}] ${message}${status ? ` (http ${status})` : ""}`);
    this.serverMessage = message;
  }
  /** The message as the server sent it. */
  readonly serverMessage: string;
}

/** Code 1006. A read is retried automatically; this reaches you after the last attempt. */
export class RateLimitError extends ApiError {
  override name = "RateLimitError";
  constructor(message: string, status: number | undefined, rpc: string | undefined) {
    super(RATE_LIMIT_CODE, message, status, rpc, true);
  }
}

/** No usable answer. `sent` says whether the request may have left this process. */
export class TransportError extends GrvtError {
  override name = "TransportError";
  constructor(
    message: string,
    readonly rpc: string | undefined,
    readonly sent: boolean,
    override readonly cause?: unknown,
  ) {
    super(rpc ? `${rpc}: ${message}` : message);
  }
}

/**
 * A write was in flight when the connection dropped or the call timed out. The order may or may not
 * exist; look it up (e.g. by clientOrderId). The SDK never resends a write.
 */
export class OrderStateUnknown extends GrvtError {
  override name = "OrderStateUnknown";
  /** Every client order id the write carried (several for bulkOrders, none for a pure cancel). */
  readonly clientOrderIds: readonly string[];
  /** The client order id when the write carried exactly one order. */
  readonly clientOrderId: string | undefined;
  constructor(
    readonly rpc: string,
    readonly reason: string,
    clientOrderIds: ClientOrderIds,
    override readonly cause?: unknown,
  ) {
    const ids =
      clientOrderIds === undefined
        ? []
        : typeof clientOrderIds === "string"
          ? [clientOrderIds]
          : [...clientOrderIds];
    super(
      `${rpc}: outcome unknown (${reason})` +
        (ids.length === 1 ? `, client_order_id=${ids[0]}` : "") +
        (ids.length > 1 ? `, client_order_ids=${ids.join(",")}` : ""),
    );
    this.clientOrderIds = ids;
    this.clientOrderId = ids.length === 1 ? ids[0] : undefined;
  }
}

/** The client order id(s) an order write carries: one for createOrder, a list for bulkOrders. */
export type ClientOrderIds = string | readonly string[] | undefined;

/**
 * The consumer fell behind a stream that may not drop items. The queue was cleared and the
 * subscription re-synced; items in between are lost. Keep iterating: the next item is fresh.
 */
export class StreamOverflow extends GrvtError {
  override name = "StreamOverflow";
  constructor(
    readonly stream: string,
    readonly selector: string,
    readonly capacity: number,
  ) {
    super(`${stream} ${selector}: consumer fell behind ${capacity} items; re-syncing`);
  }
}

/** What OrderOutOfBounds says about the failing leg. Values are decimal strings without trailing zeros. */
export interface OrderOutOfBoundsDetail {
  instrument: string;
  /** Index of the failing leg. */
  leg: number;
  /** The leg field checked, or "limit_price * size" for the notional. */
  field: string;
  check: "at_least" | "multiple_of";
  /** The instrument field it is checked against: tick_size, min_size or min_notional. */
  limit: string;
  value: string;
  limitValue: string;
  /** The nearest valid values of `field` (of size, for the notional). */
  nearest: readonly string[];
  /** The gateway error the order would get, e.g. 2064 (invalid limit price tick). */
  serverCode: number;
}

/**
 * An order leg breaks one of its instrument's limits. Thrown before signing; nothing was sent. The SDK
 * never rounds an order: pick one of `nearest` and send again.
 */
export class OrderOutOfBounds extends GrvtError implements OrderOutOfBoundsDetail {
  override name = "OrderOutOfBounds";
  readonly instrument: string;
  readonly leg: number;
  readonly field: string;
  readonly check: "at_least" | "multiple_of";
  readonly limit: string;
  readonly value: string;
  readonly limitValue: string;
  readonly nearest: readonly string[];
  readonly serverCode: number;
  constructor(message: string, d: OrderOutOfBoundsDetail) {
    super(message);
    this.instrument = d.instrument;
    this.leg = d.leg;
    this.field = d.field;
    this.check = d.check;
    this.limit = d.limit;
    this.value = d.value;
    this.limitValue = d.limitValue;
    this.nearest = d.nearest;
    this.serverCode = d.serverCode;
  }
}

/** A request could not be signed (missing field, over-precise decimal, unknown metadata). Nothing was sent. */
export class SigningError extends GrvtError {
  override name = "SigningError";
  constructor(message: string) {
    super(`signing: ${message}`);
  }
}

/**
 * A decimal string that cannot be signed exactly: `kind` is "malformed" (not a decimal) or "precision"
 * (more fractional digits than the field signs with; `places` counts them without trailing zeros).
 * `at` names the field when the value came from a request.
 */
export class DecimalError extends SigningError {
  override name = "DecimalError";
  constructor(
    readonly kind: "malformed" | "precision",
    readonly value: string,
    readonly decimals: number,
    readonly places: number,
    readonly at?: string,
  ) {
    super(
      (at ? `${at}: ` : "") +
        (kind === "malformed"
          ? `not a decimal: ${JSON.stringify(value)}`
          : `${value} has more than ${decimals} decimal places`),
    );
  }

  /** The same error, naming the field it was read from. */
  withAt(at: string): DecimalError {
    return new DecimalError(this.kind, this.value, this.decimals, this.places, at);
  }
}

/** The encoded WS frame is larger than the server accepts. Nothing was sent. */
export class FrameTooLarge extends GrvtError {
  override name = "FrameTooLarge";
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`frame is ${size} bytes, server limit ${limit}; use orderTransport "rest" for this call`);
  }
}

/** A response or stream frame did not decode. */
export class DecodeError extends GrvtError {
  override name = "DecodeError";
}

/** The client is missing something the call needs (signer, api key) or was given a bad option. */
export class ConfigError extends GrvtError {
  override name = "ConfigError";
}

/** The client was closed. */
export class ClosedError extends GrvtError {
  override name = "ClosedError";
  constructor() {
    super("client closed");
  }
}

/** The contract's error table plus the retry rule. */
export class ErrorTable {
  private readonly byCode = new Map<number, ErrorInfo>();

  constructor(rows: readonly ErrorInfo[] = []) {
    for (const r of rows) this.byCode.set(r.code, r);
  }

  get(code: number): ErrorInfo | undefined {
    return this.byCode.get(code);
  }

  /** The contract rule: the rate-limit code, a code the table marks retryable, or a read retry status. */
  retryable(code: number, status?: number): boolean {
    return behavior.readRetryable(code, status, this.byCode.get(code)?.retryable === true);
  }

  responseError(value: unknown, status: number | undefined, rpc: string): ApiError {
    const body = value as { code?: unknown; message?: unknown } | null;
    if (
      typeof body?.code === "number" &&
      Number.isInteger(body.code) &&
      typeof body.message === "string"
    )
      return this.apiError(body.code, body.message, status, rpc);
    return this.apiError(0, "malformed error reply", status, rpc);
  }

  /** Whether a write that failed with this error may have reached the exchange. */
  uncertain(error: ApiError): boolean {
    return behavior.writeOutcomeUnknown(error.status, this.get(error.code)?.status);
  }

  apiError(
    code: number,
    message: string,
    status: number | undefined,
    rpc: string | undefined,
  ): ApiError {
    if (code === RATE_LIMIT_CODE) return new RateLimitError(message, status, rpc);
    return new ApiError(code, message, status, rpc, this.retryable(code, status));
  }
}

/** Whether a read may be retried after this error. */
export function isRetryable(e: unknown): boolean {
  return e instanceof TransportError || (e instanceof ApiError && e.retryable);
}

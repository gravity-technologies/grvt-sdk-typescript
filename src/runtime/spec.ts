// Descriptors the generator emits, one per RPC and one per stream. The runtime reads only these.

/** "md" market data, "td" trading, "edge" login. */
export type Gateway = "md" | "td" | "edge";

export interface RpcSpec {
  readonly defaultSubAccount?: boolean;
  readonly encode?: (value: unknown) => unknown;
  readonly decode?: (value: unknown) => unknown;
  /** Contract id, e.g. "order.create_order". */
  readonly id: string;
  /** JSON-RPC method and REST route tail, e.g. "v1/create_order". */
  readonly method: string;
  readonly gateway: Gateway;
  /** REST path, e.g. "/full/v1/create_order" (edge routes differ). */
  readonly path: string;
  /** Needs the session cookie. */
  readonly auth: boolean;
  /** Changes state: never retried; an ambiguous failure is OrderStateUnknown. */
  readonly write: boolean;
  /** Goes over the trading WS when the client uses orderTransport "ws". */
  readonly orderEntry: boolean;
  /** Top-level request fields that must be set. */
  readonly required: readonly string[];
  /**
   * Field holding the Order(s) whose metadata.client_order_id the runtime fills when absent: "order"
   * ({order: Order}), a list field such as "orders" (one id per element), or false.
   */
  readonly clientOrderId: false | string;
  /**
   * Error codes that mean the cached instrument limits may be stale: the runtime drops the request's leg
   * instruments from the metadata cache (the order itself is never resent). Absent for most calls.
   */
  readonly refreshMetadataOn?: readonly number[];
}

export interface SelectorField {
  /** Wire name, e.g. "instrument". */
  readonly name: string;
  readonly required: boolean;
}

export interface StreamSpec {
  readonly decode?: (value: unknown) => unknown;
  readonly id: string;
  /** e.g. "v1.book.d" */
  readonly stream: string;
  readonly gateway: Gateway;
  readonly auth: boolean;
  /** Every frame is complete (e.g. "v1.ticker.s"): a gap is reported but needs no resync. */
  readonly snapshotFeed: boolean;
  /** Old items may be dropped for a slow consumer. False: overflow is StreamOverflow and a re-sync. */
  readonly conflate: boolean;
  /** Selector grammar: primary fields joined by "-", then "@" and the secondary fields joined by "-". */
  readonly primary: readonly SelectorField[];
  readonly secondary: readonly SelectorField[];
}

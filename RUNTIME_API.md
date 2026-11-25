# TypeScript runtime API (generator target)

Generated code in `src/generated/` talks to the hand-written runtime (`src/runtime/`) only through
the names on this page, all exported from `src/runtime/index.ts`. If the generator needs something
not listed here, add it to the runtime and to this page; never reach into private fields.

The generator is `sdk/generator/typescript` (`make sdk-gen-typescript`, or `make sdk-gen-code` for every SDK and the docs). Its
output in `src/generated/` (not committed) is the reference for everything below. Naming and write rules shared
with the other generators live in `sdk/generator/naming`.

## 1. Models (one interface per contract type)

```ts
/** One-line description. */
export interface OrderLeg {
  /** The instrument to trade in this leg */
  instrument: string;
  size: Decimal;
  is_buying_asset: boolean;
}
```

- Public field names follow contract aliases. Required fields stay required in types and decoding.
  Nullable fields include `null`. Signed calls use `Input` models. Only declared partial streams
  use `Partial` payload models.
- Wire type -> TypeScript type (from the contract's `type`):

  | wire | TypeScript | notes |
  |---|---|---|
  | decimal string (`"65000.1"`) | `Decimal` | exact validated text, explicit conversions |
  | uint64 / int64 | `string` | they travel as JSON strings; a JS number cannot hold them |
  | uint128 / uint256 (hex) | `string` | |
  | uint8/16/32, int8/16/32 | `number` | |
  | enum | `e.TimeInForce` | a string union of the known values plus any string |
  | bool / string / any / list / nested type | `boolean` / `string` / `unknown` / `T[]` / `T` | |

- The generated schema decodes exact values and checks required keys. Unknown fields are kept.

## 2. RPCs (one `RpcSpec` constant + one method)

```ts
export const ORDER_CREATE_ORDER: RpcSpec = {
  id: "order.create_order",
  method: "v1/create_order",      // JSON-RPC method == REST route tail
  gateway: "td",                  // "md" | "td" | "edge"
  path: "/full/v1/create_order",  // REST path (edge routes use their own path)
  auth: true,                     // needs the session cookie
  write: true,                    // never retried; ambiguous failure -> OrderStateUnknown
  orderEntry: true,               // goes over the trading WS when orderTransport is "ws"
  required: ["order"],            // top-level fields that must be set
  clientOrderId: "order",         // field holding the order(s): fill each one's metadata.client_order_id
                                  // when absent ("orders" for bulk_orders; false for other calls)
  refreshMetadataOn: [2062, 2064, 2065, 2066, 2067], // order calls only: on these codes, drop the
                                  // request's legs[].instrument from the metadata cache
};

export class Api { // the base of Grvt: one method per RPC and stream
  constructor(readonly runtime: Runtime) {}
  createOrder(request: Req<m.ApiCreateOrderRequestInput, "order">, options?: CallOptions): Promise<m.ApiCreateOrderResponse> {
    return this.runtime.call(specs.ORDER_CREATE_ORDER, request, options, signing.signOrderCreateOrder);
  }
}
```

`Req<T, K>` makes the required keys non-optional. A request with no required field defaults to `{}`.

`Runtime.call(spec, request, options?, sign?)` does, in order: required-field check -> copy the
request (the caller's object is never changed) -> fill `client_order_id` -> `beforeSend` hook ->
`sign(rt, request)` -> `JSON.stringify` -> log in if `auth` -> REST or WS -> `JSON.parse`. For REST
the whole body is the response; over WS the JSON-RPC `result` is the same object. Errors are thrown:
`ApiError` (`RateLimitError` for 1006), `TransportError`, `OrderStateUnknown`, `SigningError`,
`OrderOutOfBounds`, `ConfigError`, `DecodeError`, `FrameTooLarge`, `ClosedError`. An unknown outcome reports
the `client_order_id`s filled before the hook. `beforeSend` may change the request but must not add, remove or reorder orders, or change their client order IDs (prices, sizes and other fields may change): if it does, the call throws `ConfigError` and sends nothing.

## 3. Streams (one `StreamSpec` constant + one method)

```ts
export const STREAM_ORDERBOOK_ORDERBOOK_DELTA: StreamSpec = {
  id: "orderbook.orderbook_delta", stream: "v1.book.d", gateway: "md", auth: false,
  snapshotFeed: false, // true when every frame is complete (e.g. v1.ticker.s): a gap needs no resync
  conflate: false,     // true: a slow consumer loses the oldest items; false: StreamOverflow + resync
  primary: [{ name: "instrument", required: true }],
  secondary: [{ name: "rate", required: false }, { name: "depth", required: false }],
};

orderbookDeltaStream(selector: { instrument: string; rate?: number; depth?: number }): Subscription<m.WSOrderbookLevelsFeedDataV1> {
  return this.runtime.stream(specs.STREAM_ORDERBOOK_ORDERBOOK_DELTA, selector);
}
```

`Runtime.stream(spec, selector)` checks required selector fields (throws `ConfigError` at
once), builds the selector `p1-p2@s1-s2` from the fields that are set, and returns a
`Subscription<F>`. Nothing is sent until it is iterated or `subscribe()` is awaited. `F` is the whole
frame (`stream`, `selector`, `sequence_number`, `prev_sequence_number`, `feed`). Conflation is on
for snapshot streams only; every other stream (deltas, events, private) never drops silently. Every stream
method gets a `Stream` suffix (`naming.StreamSuffix`, camel-cased), so it never shares a name with an RPC.

## 4. Signed types (one `StructType` constant + message builders + one sign function per signed call)

```ts
// StructType is internal: only generated code constructs one, always with its generated encoder.
export const EIP712_ORDER = new StructType("Order", {
  Order: [{ name: "subAccountID", type: "uint64" }, /* ... */ { name: "legs", type: "OrderLeg[]" }],
  OrderLeg: [{ name: "assetID", type: "uint256" }, /* ... */],
}, "0xb4b857ba...", hashOrder);   // contract type hash (checked at load) + generated encoder
```

Messages are plain objects keyed by EIP-712 field name, built from the typed request with optional
chaining (so `tsc` checks every contract path):

```ts
function messageOrder(d: m.ApiCreateOrderRequestInput, meta: w.Meta): Message {
  return {
    subAccountID: w.copy(d.order?.sub_account_id, "uint64", "order.sub_account_id"),
    timeInForce: w.enumCode(d.order?.time_in_force, ENUM_CODES.TimeInForce, "order.time_in_force"),
    legs: w.each(d.order?.legs).map((e) => messageOrderOrderLeg(e, meta)),
    // ...
  };
}

export async function signOrderCreateOrder(rt: Runtime, d: m.ApiCreateOrderRequestInput): Promise<m.ApiCreateOrderRequestInput> {
  const sig = (d.order ??= {}).signature ??= {};
  w.prepareSignature(rt, sig, SIGNATURE_TTL_NS);           // signer, nonce, expiration, chain_id when absent
  const meta = await metadata(rt, instruments, currencies); // cached get_instrument / get_currency
  checkOrder(ORDER_CHECKS, d.order, meta);                 // calls that carry an Order
  // variant rule picks the StructType, then:
  await w.signInto(rt, sig, st, message);                  // domain chainId = signature.chain_id or env's; writes r/s/v
  return d;
}
```

Contract transform -> generated expression (`src/runtime/signing/wire.ts` imported as `w`):

| transform | code |
|---|---|
| `copy`, `sig.nonce`, `sig.expiration` | `w.copy(value, "<eip type>", "<where>"[, default])` |
| `address` | `w.address(value, where)` (absent = zero address) |
| `enumCode` | `w.enumCode(value, ENUM_CODES.<Enum>, where)` (absent = 0; an unknown value throws) |
| `scaled` fixed | `w.scaled(value, 9, where[, default])` (throws on over-precision, never rounds) |
| `scaled` instrument_base_decimals | `w.scaled(value, meta.instrument(name).base_decimals, where)` |
| `scaled` currency_balance_decimals | `w.scaled(value, meta.currency(symbol).balance_decimals, where)` |
| `assetKey` | `meta.assetKey(name)` |
| `currencyId` | `meta.currencyId(symbol)` |
| `each` | `w.each(list).map((e) => message<Type><Nested>(e, meta))` |

Integers are `bigint`, addresses lowercase `0x` strings. Variant rule kinds the generator knows:
`builder`, `wallet_types`, `currency_width`, and a single type; an unknown kind fails generation.
How signers receive these messages: [Signing path](#signing-path).

`ORDER_CHECKS: OrderChecks` is the contract's `order_checks` (`legs`, `instrument`, `scales` as a number
or `"base_decimals"`, `rules`). Both validators read the order and take a `meta` object with an
`instrument(name)` method. `loadInstrument` fills the limits in `InstrumentMeta.limits`.

`checkOrder` throws on the first problem. An instrument limit violation raises `OrderOutOfBounds`.
A missing instrument or unreadable value raises `SigningError`, including `DecimalError` for a
malformed or overly precise decimal. Lookup errors and malformed instrument limits propagate.

For a form that shows several problems at once, iterate over `orderIssues(checks, order, meta)`.
Each `OrderIssue` gives the zero-based leg index, field, and error. A malformed field skips rules that
need its value. While a form is waiting for instrument data, call `orderIssues(checks, order)` to
check only fixed-scale fields. With `meta` supplied, every leg must resolve to an instrument.
`checkOrder` always requires metadata.

Also exported for code that checks signatures outside a client (the docs widgets use them):

- `recoverAddress(digest, r, s, v)`: the lowercase `0x` address that signed the 32-byte digest, or
  `undefined` when it does not recover (any v other than 27 or 28 is `undefined`). It only recovers: a
  high-s signature recovers to the same address as its low-s twin. Use `checkSignature` to decide validity.
- `checkSignature(digest, sig, address)`: why a wallet/KMS signature is not valid for the digest and address
  (32-byte r and s, v 27 or 28, low-s, recovers to the address, `signer` field matches), or `undefined`.
  The server applies the same v, low-s and recovery rules.
- `scaleDecimal(text, decimals)`: the exact integer a decimal string signs as (`"65000.1"`, 9 ->
  `65000100000000n`); never rounds. Throws `DecimalError` (a `SigningError`) whose `kind` is `"malformed"`
  (not a decimal) or `"precision"` (more than `decimals` places; `places` is how many it has, without
  trailing zeros). Sign functions and `checkOrder` throw the same error with `at` naming the field
  (`OrderLeg.size`).

The `mainAccount` transform signs the session's main account, which no request field carries: the
generated `loadMainAccount` reads it from the call and field named in contract `signed.main_account`
(`account.funding_account_summary` -> `result.main_account_id`), once per client; a failed load is retried.

The runtime surface the sign functions use: `rt.call`, `rt.metadata` (`instrument`, `currency`,
`mainAccount`, `putInstrument`, `putCurrency`, `putMainAccount`, `dropInstrument`), `rt.signer`, `rt.clock`, `rt.nonces`, `rt.env`,
`rt.sign`, `checkOrder`.

## 5. Errors

```ts
export const ErrorCode = { SIGNATURE_EXPIRED: 2001, /* ... */ } as const;
export const ERRORS: readonly ErrorInfo[] = [{ code: 1000, name: "Unauthorized", status: 401, message: "...", retryable: false }, /* sorted */];
```

The client passes `ERRORS` to the runtime for the retry rule (`rate_limit_code`, a code the table marks
retryable, or a status in `read_retry_statuses`; both keys live in the generated behavior module).

## 6. Enums

```ts
export const TimeInForce = { GOOD_TILL_TIME: "GOOD_TILL_TIME", /* ... */ } as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce] | (string & {});
export const ENUM_CODES = { TimeInForce: { GOOD_TILL_TIME: 1, /* ... */ }, /* ... */ } as const;
```

## 7. Specs and client shell

`specs.ts` also holds `CONTRACT_VERSION`, `ENVIRONMENTS` (the non-optional contract environments)
and `OPERATIONS` (docs namespace, method name on the client, contract id, kind for every public method;
the coverage test uses it).

```ts
export class Grvt extends Api { // every RPC and stream is a Grvt method: client.createOrder(...)
  constructor(options: ClientOptions = {}) {
    super(new Runtime(options, {
      errors: ERRORS,
      environments: ENVIRONMENTS,
      lite: () => import("./lite.js").then((m) => m.LITE), // loaded only by lite clients
    }));
  }
  close(): Promise<void>;
}
```

`ClientOptions`: `env`, `apiKey`, `signer`, `orderTransport` (`"rest"` | `"ws"`), `encoding` (`"lite"` (default) |
`"full"`, see [Lite encoding](#lite-encoding)), `checkOrders`, `clock`,
`nonces`, `clientOrderIds`, `http` (HTTP plug-in), `webSocket` (WebSocket factory), `beforeSend`, `onEvent`,
`httpAttemptTimeoutMs`, `callTimeoutMs`, `wsRequestTimeoutMs`, `queueSize`, `resyncTimeoutMs`, `idleTimeoutMs`.

`CallOptions.timeoutMs` bounds the complete call, including hooks, signing, metadata, authentication, retries and the response;
it overrides the client's `callTimeoutMs`. `httpAttemptTimeoutMs` caps each HTTP attempt and `wsRequestTimeoutMs` a WebSocket reply
or subscription acknowledgement. Defaults come from `src/generated/behavior.ts` (built from `contract/behavior.json`). All timeout values must be finite and positive.

Pass an `AbortSignal` as `CallOptions.signal` for native cancellation.
Before dispatch, cancellation throws the signal's reason and a deadline throws a `TimeoutError` DOMException.
After a write starts, cancellation or a deadline throws `OrderStateUnknown` with the client order IDs and the original cause.
Shared metadata and login work can finish for other callers after one caller stops waiting.
Closing the client aborts its owned network work.
Synchronous hooks and noncooperative plug-ins cannot be interrupted, but the runtime checks the absolute deadline again before dispatch.

A custom `HttpTransport` must honor the optional `AbortSignal` and report whether a failed request was sent.
A cancelled caller still receives an unknown outcome if a custom transport ignores cancellation after dispatch.

## Lite encoding

By default (`encoding: "lite"`) every gateway call and stream of the client uses the gateways' lite encoding: the
same API with short JSON field names (the order book is about a third smaller on the wire). Routes, WS
methods, stream channels, values and enums don't change. Login (edge) and `GET /time` stay full.

Lite is a wire encoding only. Requests are built, checked, hooked (`beforeSend`) and signed with full names;
the runtime renames them just before they are written and renames replies and frames back before the
generated decoder runs. Models, errors and events never show a lite name (`frame` events carry the raw text,
so they are lite).

The moving parts:

- `src/generated/lite.ts` (`lite.ts` from `sdk/generator/typescript/lite.go`): every gateway type's fields as
  `[full name, lite name, nested type]`, plus per RPC id the lite REST path
  (`transport.lite.http_path_template`) and request and response types, per stream id the feed's type, the
  envelope types, the stream frame keys and the HTTP error body keys (`transport.lite.http_error_body`).
  Nothing imports it statically: `Tables.lite` loads it with `import()` on a lite client's first call or
  connect, so a full client never loads it and bundlers split it out.
- `LiteCodec` (`src/runtime/lite.ts`, internal): renames per type, never with one global table, because
  lite names repeat across types (`s` is a frame's stream and a book level's size). Decoding skips keys
  the type doesn't have (testnet ticker frames carry an unlisted `fi`). Encoding throws `ConfigError` on
  one, before anything is sent: the lite server reads an unknown key as an absent field, so a full name
  sent to a lite path would silently be lost.
- REST: `POST {gateway}/lite/v1/<route>`; error bodies `{"c","m","s","ri"}` are renamed before
  `ErrorTable.responseError`.
- WebSocket: the environment's `mdWsLiteUrl` / `tdWsLiteUrl` when set, else `mdWsUrl` / `tdWsUrl` with
  `/ws/full` swapped for `/ws/lite` (`wsUrl` in `env.ts`). Requests are `{"j","m","p","i"}`, subscribe
  and unsubscribe params use their types' lite names. The socket renames only the envelope of each frame
  (reply `id`, `result`, `error`, or a stream frame's `stream`, `selector`, sequence numbers); an RPC result
  is renamed by the call's response type and a stream frame's `feed` by the stream's feed type when the
  consumer takes it. Error replies can carry id 0 and an empty method, as in full.
- `Environment.mdWsLiteUrl` / `tdWsLiteUrl` are optional. A lite client whose full WS URL doesn't end in
  `/ws/full` and has no lite URL set is a `ConfigError` at construction.
- The full path is unchanged: the same bytes, and one check of a field per call and frame.
- `runtime.md.request(method, paramsJson, ...)` sends `paramsJson` as given: on a lite socket it must
  already use lite names, and the result comes back lite.

## Signing path

The SDK signs only Grvt's generated message types; there is no public generic EIP-712 hashing.
`StructType` is exported as a type only. Each signed type has a generated encoder (one preallocated
buffer per struct, type hashes computed by the generator); the domain separator is cached per chain id.

- `PrivateKeySigner`: the runtime hashes with the generated encoder and signs the digest directly.
- Any other `Signer` (wallet, KMS, HSM) gets `signTyped(domain, type, message)` and may hand
  `type.toTypedData(domain, message)` to eth_signTypedData_v4. The runtime then checks the returned
  r/s/v against the generated digest and throws `SigningError` if it fails the checks listed in
  [Sign with a wallet or KMS](https://developers.grvt.io/sdks/typescript#sign-with-a-wallet-or-kms) (low-s, recovers to `signer.address`,
  signer field empty or equal to it). A KMS signer normalizes a high s as s = n - s, flip v.

## HTTP redirects and retries

The SDK never follows a redirect or retries a write, and a custom HTTP transport must not either: the rule and
why are in [What the SDK retries](https://developers.grvt.io/guides/errors-and-retries#what-the-sdk-retries).

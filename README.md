# grvt (TypeScript SDK, preview)

> **Preview.** This SDK is still being stabilised. Its API can change in any 0.x release, so pin an exact
> version. It becomes stable at 1.0.0.

The TypeScript SDK for Grvt: REST, WebSocket streams, WebSocket order entry, EIP-712 signing and
login in one ESM package for Node >= 22 and modern browsers. It mirrors the Python and Rust SDKs
(`sdk/languages/python`, `sdk/languages/rust`): same operations, same behaviour, idiomatic names. Everything that grows
with the API (models, enums, error codes, RPC/stream methods, sign functions) is generated from
`sdk/contract/contract.json` by `sdk/generator/typescript`; the hand-written runtime in `src/runtime`
stays the same size however many APIs exist.

Runtime dependencies: `@noble/curves` and `@noble/hashes` only. HTTP and WebSocket use the global
`fetch` and `WebSocket`.

## Install

```
npm ci
npm run build
```

## Quickstart

Use the [canonical quickstart](https://developers.grvt.io/guides/quickstart) and
[download its TypeScript example](https://developers.grvt.io/downloads/examples/typescript/examples/quickstart.ts).
The example reads public testnet data by default. Add `--trade` to place, observe, and cancel one testnet order.
Trading requires `GRVT_API_KEY`, `GRVT_PRIVATE_KEY`, and `GRVT_SUB_ACCOUNT_ID`. An order can fill before cancellation.
The example uses current instrument limits and stops after bounded observation attempts.

From this SDK's directory, run:

```sh
npm ci
npm run example
```

The npm package contains the library, not the example files. Download the example or use a source checkout.
`npm run example -- --trade` enables trading. The command compiles TypeScript before running JavaScript, including on Node 22.0.

Every RPC is a method directly on the client, `client.<method>(request)`: the contract's `method_name` in
camelCase (`create_order` -> `client.createOrder`). Every stream method ends in `Stream`
(`client.tradeStream`). The contract's namespace is only a docs category and never appears in your code.
Request and response fields
keep the wire names (`sub_account_id`) because they are the JSON. Required fields are required by the
type and checked again before anything is signed or sent. A stream method takes its selector fields
and returns a `Subscription`: an async iterable of frames with `close()`.

Errors are classes: `ApiError` (`code`, `status`, `rpc`, `retryable`), `RateLimitError` (a subclass,
code 1006), `TransportError` (`sent`), `OrderStateUnknown` (`clientOrderId`, `clientOrderIds`), `StreamOverflow`,
`SigningError`, `ConfigError`, `DecodeError`, `FrameTooLarge`, `ClosedError`; all extend `GrvtError`.
Error code constants are in `ErrorCode`.

**Browsers:** public REST and public streams work. Anything that needs the session (private REST,
private streams, WS order entry) is Node-only in this draft: browsers neither expose `Set-Cookie`
from the login nor let code set `Cookie` or custom headers on a WebSocket handshake.

## Generated source

The public source repo includes the generated code and shared test fixtures. For development in the platform
monorepo, run `make sdk-gen-typescript` from its root before building this SDK. Generated source comes from the
Grvt API contract. Send proposed changes to the Grvt maintainers so they can update the monorepo.

## Layout

```
src/index.ts            public names: Grvt, models, enums, signing, errors, signers, hooks, ...
src/generated/          GENERATED (do not edit): models, enums, errors, codec, specs, signing, api, client, lite
src/runtime/            hand-written runtime, same size however many APIs exist
  runtime.ts            Runtime: call(), stream(), sign(), session rotation, metadata cache, options
  ws.ts                 one managed socket per gateway; Subscription
  protocol.ts           sans-IO state: request table, sequencer, backoff (unit-tested)
  rest.ts, http.ts      REST calls with read retries; HTTP plug-in (global fetch)
  auth.ts               api-key login, gravity cookie + X-Grvt-Account-Id, re-login at 80% of lifetime
  signing/              EIP-712 for generated types, Signer + PrivateKeySigner, wire transforms, secp256k1 (@noble), keccak256 (own)
  hooks.ts, log.ts      beforeSend / onEvent; GRVT_LOG=debug with redaction
  lite.ts               lite encoding: per-type renames at the wire edge (table loaded only when used)
  env.ts, clock.ts, errors.ts, spec.ts
RUNTIME_API.md          the contract between generator (sdk/generator/typescript) and runtime
test/                   signing case replay, fake-gateway WS/REST tests, protocol and coverage tests, testnet smoke
examples/quickstart.ts  public market data; places an order when credentials are in the environment
```

## Run the tests

```
npm install
npm test                                              # everything offline
npm run typecheck
GRVT_SMOKE=1 npx vitest run test/smoke.test.ts        # read-only, unauthenticated testnet check (full and lite)
npm run example                                      # compile, then run the canonical example
```

## How the main pieces behave

Same as Python and Rust:

- **Order transport** is per client (`orderTransport: "rest"` default, or `"ws"`). Order-entry writes
  (writes in the `order` namespace) go over the trading WebSocket when `"ws"`. Writes are never
  retried. If a write may have reached the exchange but no answer came back (timeout, socket drop),
  the call throws `OrderStateUnknown` with `clientOrderId`; look the order up
  (`client.getOrder({ sub_account_id, client_order_id })`), don't resend.
- **Encoding** is per client (`encoding: "lite"` default, or `"full"`). Lite uses the gateways' short
  JSON field names on every call and stream (order book frames about a third smaller); models, hooks,
  signing and errors keep full names, and login stays full. Lite WebSockets use `mdWsUrl` / `tdWsUrl`
  with `/ws/full` swapped for `/ws/lite`; set `mdWsLiteUrl` / `tdWsLiteUrl` on a custom `Environment` only
  when its URLs don't end in `/ws/full`. Details: [RUNTIME_API.md](RUNTIME_API.md#lite-encoding).
- **Reads** retry up to 3 attempts with full-jitter backoff on retryable errors (1006, a code the
  contract marks retryable, HTTP 502/503/504, or no answer).
- **Signing** covers Grvt's own messages only: one generated EIP-712 encoder per signed type, built
  from the contract mappings and variant rules. Wallet/KMS signers get the typed data; their signature
  must be low-s, recover to `signer.address` and have a signer field that is empty or equal to it, or
  signing throws `SigningError` (normalize a high s from KMS backends such as AWS KMS). `createOrder`
  fills `client_order_id`, the signature's signer, nonce, expiration (24h) and chain id, and looks up
  instrument/currency metadata once (cached). Over-precise decimals throw `SigningError`; nothing is
  rounded. Every signing case and order check in `sdk/scenarios/signing.json` reproduces exactly.
- **Order checks**: before signing, each leg is checked against its instrument's tick, size step,
  `min_size` and `min_notional`. A miss throws `OrderOutOfBounds` with the nearest valid values; nothing
  is sent and nothing is rounded. If the exchange still rejects an order for these limits, the
  instrument's cached metadata is dropped so the next order refetches it. `checkOrders: false` turns the
  check off and leaves the limits to the exchange.
- **Streams** use global sequence numbers. The snapshot frame has `sequence_number` 0, and the
  first update's `prev_sequence_number` is at or below the subscribe reply's `latest_sequence_number`. The
  first frame after a (re)subscribe reply is accepted
  when its `prev_sequence_number` is 0 or not greater than the latest sequence number known then
  (testnet sends the old sequence number there). After that, `prev_sequence_number` must equal the
  last sequence number seen; otherwise it is a gap: the runtime re-subscribes the same selector and
  drops frames until the new snapshot. No snapshot within 5s -> reconnect. On reconnect every
  subscription is re-sent.
- **Backpressure**: the read loop never waits for a consumer; each subscription has a bounded queue.
  Only snapshot streams (every frame complete, `*.s`) drop the oldest frame when the consumer falls
  behind. Every other stream (deltas, events, private) throws `StreamOverflow` and re-syncs.
- **Session**: api-key login on edge gives the `gravity` cookie and `X-Grvt-Account-Id`; both go on
  authenticated REST calls and on the WS handshake. The runtime re-logs in at 80% of the cookie
  lifetime and moves sockets over.
- **Hooks**: `beforeSend(call)` runs before signing and may edit `call.params` (or return new params);
  `onEvent(event)` gets typed events (`connect`, `disconnect`, `reconnect`, `subscribe`, `gap`,
  `retry`, `frame`, `session_rotated`, `error`). For example, `onEvent: (e) => e.type === "gap" &&
  console.warn(e.stream, e.expectedPrev, e.prev)`.
- **Logging**: `GRVT_LOG=debug` logs to stderr with the cookie, api key, private keys and r/s redacted
  (`setLogLevel()` does the same at runtime).
- **64-bit integers are strings**; decimal fields use `Decimal` and timestamps use `Timestamp`.
  `Decimal.toString()` preserves the text; `Timestamp.nanoseconds` is a `bigint`. `toDate()` explicitly
  rounds down to milliseconds. Required fields stay required in interfaces and decoding. Nullable fields
  include `null`. Signed calls use `Input` models for SDK-filled fields. Only contract-declared partial
  streams use `Partial` payloads. Unknown enum values still decode.

## Draft notes (shortcuts and TODOs)

- **Session-bound features are Node-only** (see Browsers above). A browser build would need a
  same-origin proxy or a token the gateways accept on the WS URL.
- **A rejected WS handshake cannot be told apart from a network error.** The global `WebSocket` does
  not expose the HTTP status, so a 401/403 handshake is retried with backoff instead of stopping for
  good (a failed api-key login still stops it). A `webSocket` factory that knows the status can set
  `status` on the close event; the fake gateway in the tests does.
- **No client heartbeat or idle timeout.** The global `WebSocket` has no ping API and hides the
  server's pings, so a quiet but dead connection is noticed only when TCP gives up. Python and Rust
  ping every 10s and drop a socket after 30s without frames.
- **Book deltas are never conflated.** The local `OrderBook` helper merges levels.
  Queue overflow invalidates continuity. See [rebuild a book after a gap](https://developers.grvt.io/guides/recovery#rebuild-a-book-after-a-gap).
- **Session rotation on WS is simplified** (break-before-make, as in Python/Rust): after a re-login a
  socket waits for no writes in flight, then reconnects with the new cookie.
- **Frame-size check exists but is off** (`Environment.wsMaxFrameBytes` is unset for the named envs);
  when set, an oversized frame throws `FrameTooLarge` and nothing is sent. REST fallback is a TODO.
- **Responses decode decimal and timestamp fields using the contract.** These fields reject invalid values.
  Other fields retain their wire representation; unknown fields are kept. The gateway sends wide integers as strings.
- **Private-stream resume** is not possible until the server supports it; callers backfill via REST.
- **Read/write access is explicit in the contract.** Unclassified calls stop generation; only reads can retry.
- **Flat names must be unique**: methods are not grouped by namespace, so the generator fails if two calls
  (or two streams) in different namespaces share a `method_name`.
- **Signing scope** matches Python/Rust: Order / OrderWithBuilderFee (also each order of
  `bulkOrders`, signed on its own), Transfer V1-V3, Withdrawal V1-V2, WalletLogin. Algo orders, vault
  and session keys are not bound in the contract yet. `createOrder` and `bulkOrders` fill a missing
  `client_order_id` on each order.
- **Authentication belongs to the session runtime.** Set `apiKey` on the client to log in.
  Raw edge login routes are not generated client methods; wallet session login is not supported.
- **Client order ids** use the wall clock (`TimeCounterClientOrderId`), not the configured `clock`.
- **Not published to npm**; the package name `grvt` is a placeholder. No Bazel BUILD files.

## Timeouts

`callTimeoutMs` defaults to 30000 milliseconds for the whole RPC, including authentication, metadata, signing, retries, and the response.
`httpAttemptTimeoutMs` caps each HTTP attempt at 10000 milliseconds by default, within the remaining total limit.
Set `options.timeoutMs` on one call to override its total limit. An earlier abort signal still wins.
Replace the old `requestTimeoutMs` setting with `httpAttemptTimeoutMs`.

## Uncertain orders and stream gaps

Use the [recovery helpers and gap ranges](https://developers.grvt.io/guides/recovery) to look up uncertain orders and detect lost stream continuity.
A missing order stays unknown. The helpers never resend an order.

Bulk order requests use `order_ids` and `client_order_ids`. The SDK encodes them as the server's
`order_i_ds` and `client_order_i_ds` JSON keys. Hooks and signing see the encoded wire names.

## Pagination

Use `pages` to follow cursors without fetching ahead. Keep filters and call options in the callback.

```ts
import { pages } from "grvt";

for await (const page of pages((cursor) => client.tradeHistory({ instrument: "BTC_USDT_Perp", cursor }))) {
  for (const trade of page.result ?? []) console.log(trade);
}
```

An empty page can still have a next cursor. Breaking the loop stops further calls.
A repeated cursor throws `PaginationCycle`; fetch errors pass through without extra retries.
Cursors do not guarantee a stable snapshot while records change.

## Default sub-account

Set `subAccountId: "123"` in `new Grvt(...)` to fill omitted request and stream account IDs.
Explicit IDs take precedence. An order in `bulkOrders` first inherits the request account, then the client default.
Transfer source and destination IDs stay explicit. Defaults are applied to copies before signing.
Without a default, calls that need an account still require one.

## Recovery helpers

The SDK exposes lookup-only order resolution, history backfill with unproven continuity,
and explicit cancellation-countdown refresh.
Session rotation reports that authenticated WebSockets must reconnect.
See the [recovery recipes](https://developers.grvt.io/guides/recovery), including [rebuilding a local order book](https://developers.grvt.io/guides/recovery#rebuild-a-book-after-a-gap), before restoring trading after a gap.

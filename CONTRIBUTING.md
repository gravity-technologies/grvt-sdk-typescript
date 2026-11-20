# Contributing to the TypeScript SDK

This is for people changing the SDK itself. To use it, start with [README.md](README.md).

## How the source is built

Most of the SDK is generated. Everything that grows with the API (models, enums, error codes, the client's
call and stream methods, the sign functions, the lite field-name tables) is generated from
`sdk/contract/contract.json` by `sdk/generator/typescript` into `src/generated/`. Don't edit those files.

The hand-written runtime in `src/runtime/` stays the same size however many calls the API has.
[RUNTIME_API.md](RUNTIME_API.md) is the contract between the generator and the runtime.

Generated code is build output, not committed. In the platform repository, run `make sdk-gen-typescript` from
the root before building or testing. A public source copy of the SDK includes the generated code; send changes
to generated code to the Grvt maintainers so they can change the generator or contract.

The SDK mirrors the Python and Rust SDKs (`sdk/languages/python`, `sdk/languages/rust`): same operations, same
behaviour, idiomatic names.

## Build from source

Needs Node 24 or newer and the repository's Go toolchain. From the repository root:

```sh
make sdk-gen-typescript
cd sdk/languages/typescript
npm ci
npm run build
```

## Layout

```
src/index.ts            public names: Grvt, models, enums, signing, errors, signers, hooks, ...
src/generated/          GENERATED (do not edit): models, enums, errors, codec, specs, signing, api, client, lite
src/runtime/            hand-written runtime
  runtime.ts            Runtime: call(), stream(), sign(), session rotation, metadata cache, options
  ws.ts                 one managed socket per gateway; Subscription
  protocol.ts           sans-IO state: request table, sequencer, backoff (unit-tested)
  rest.ts, http.ts      REST calls with read retries; HTTP plug-in (global fetch)
  auth.ts               api-key login, gravity cookie + X-Grvt-Account-Id, re-login at 80% of lifetime
  signing/              EIP-712 for generated types, Signer + PrivateKeySigner, wire transforms,
                        secp256k1 (@noble/curves), keccak256 (own)
  hooks.ts, log.ts      beforeSend / onEvent; GRVT_LOG=debug with redaction
  lite.ts               lite encoding: per-type renames at the wire edge (table loaded only when used)
  env.ts, clock.ts, errors.ts, spec.ts
src/pagination.ts, recovery.ts, backfill.ts, orderbook.ts, countdown.ts   pages and recovery helpers
RUNTIME_API.md          the contract between generator and runtime
test/                   signing case replay, fake-gateway WS/REST tests, protocol and coverage tests, testnet smoke
bench/                  codec and signing benchmarks
examples/quickstart.ts  public market data; places an order with --trade
```

## Run the tests

```sh
npm ci
npm test                                              # everything offline
npm run typecheck
npm run lint
GRVT_SMOKE=1 npx vitest run test/smoke.test.ts        # read-only, unauthenticated testnet check (full and lite)
npm run example                                       # compile, then run the canonical example
npm run example -- --trade                            # also place, observe and cancel one testnet order
npm run bench
```

Trading needs `GRVT_API_KEY`, `GRVT_PRIVATE_KEY` and `GRVT_SUB_ACCOUNT_ID`. The order can fill before it is
cancelled. `npm run example` compiles TypeScript before running JavaScript, so it works on Node 24.0.

A test that talks to the fake gateway runs in both wire encodings (`ENCODINGS` in `test/fakes.ts`), because
clients default to lite. In lite, the fakes record requests in full names (`body`, `received`) and as sent
(`wire`), and list in `violations` any key the client sent that is not a lite name.

`make sdk-check-ts` from the repository root runs the full CI check: lint, typecheck, tests, and a packed
install that checks the package contents and runs the quickstart (`sdk/scripts/check-quickstarts.py`).

The npm package holds `dist`, README.md, RUNTIME_API.md and LICENSE, not the examples.

## Library choices

- Runtime dependencies are `@noble/curves` (secp256k1) and `@noble/hashes` only. keccak256 is our own.
- HTTP and WebSocket use the global `fetch` and `WebSocket`; both can be swapped through the `http` and
  `webSocket` client options (the tests use a fake gateway this way).

## Design notes

- **Signing** has one generated EIP-712 encoder per signed type, built from the contract mappings and variant
  rules. Every signing case and order check in `sdk/scenarios/signing.json` must reproduce exactly.
- **Read/write access is explicit in the contract.** An unclassified call stops generation; only reads retry.
- **Flat method names must be unique.** Methods are not grouped by namespace, so generation fails if two calls
  (or two streams) in different namespaces share a `method_name`.
- **Session rotation on WebSockets is break-before-make**, as in Python and Rust: after a re-login a socket
  waits until no writes are in flight, then reconnects with the new cookie.
- **Responses decode only decimal and timestamp fields** using the contract, and reject invalid values there.
  Other fields keep their wire form; unknown fields are kept.
- **Client order IDs** use the wall clock (`TimeCounterClientOrderId`), not the configured `clock`.
- **Book deltas are never conflated.** The `OrderBook` helper merges levels; a queue overflow breaks
  continuity.
- **Rejected handshakes.** The global `WebSocket` hides the HTTP status, so a 401/403 handshake is retried with
  backoff (a failed api-key login still stops it). A `webSocket` factory that knows the status can set
  `status` on the close event; the test fake gateway does.
- **No heartbeat.** The global `WebSocket` has no ping API and hides the server's pings. The other SDKs ping
  every third of `ws_idle_timeout` and drop a socket after `ws_idle_timeout` without frames.

## Open TODOs

- Session-bound features in the browser would need a same-origin proxy or a token the gateways accept on the
  WebSocket URL.
- Frame-size check: it exists but is off, because `Environment.wsMaxFrameBytes` is unset for the named
  environments. When set, an oversized frame throws `FrameTooLarge` and nothing is sent. A REST fallback is
  not built.
- What users can't do yet (private-stream resume, browser sessions, a heartbeat, ...) is listed in
  [Not supported yet](https://developers.grvt.io/sdks/typescript#not-supported-yet); keep it there.
- The package is not published to npm; the name `grvt` is a placeholder. There are no Bazel BUILD files.

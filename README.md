# grvt (TypeScript SDK)

The TypeScript SDK for the Grvt derivatives exchange: REST calls, WebSocket streams, order signing and login
in one ESM package for Node and modern browsers.

> **Preview:** 0.x releases can change the API. Pin the exact commit you build from.

## Install

**Not published to npm yet.** Build it from the Grvt platform repository (you need access to it). You need
Node 22 or newer and the repository's Go toolchain, which generates part of the source.

From the repository root:

```sh
make sdk-gen-typescript
cd sdk/languages/typescript
npm ci
npm run build
```

Then add the built package to your own project. From your application directory:

```sh
npm install /absolute/path/to/platform/sdk/languages/typescript
```

Import it as `grvt`.

## Quickstart

```ts
import { Grvt, PrivateKeySigner } from "grvt";

// The API key logs in; the signer signs orders with your signing key. Leave both out for public data only.
const client = new Grvt({
  env: "testnet",
  apiKey: process.env.GRVT_API_KEY,
  signer: new PrivateKeySigner(process.env.GRVT_PRIVATE_KEY!),
});
const t = await client.ticker({ instrument: "BTC_USDT_Perp" });
console.log(t.result.mark_price); // the exchange's fair price, used for margin
await client.close();
```

Three credentials, each needed only for private calls:

- **API key** (`apiKey`): logs the client in. Setting it is all you do; the client logs in on the first
  private call and renews the session itself.
- **Signing key** (`signer`): the private key of the wallet tied to that API key. It signs orders, transfers
  and withdrawals.
- **Sub-account ID**: the number of the trading account that holds your orders and positions. Pass it as
  `sub_account_id`, or once as the client's `subAccountId`.

More on each: [Accounts and permissions](https://developers.grvt.io/guides/accounts).

For a full run that reads testnet data and can place, watch and cancel one order, follow the
[Quickstart guide](https://developers.grvt.io/guides/quickstart) and its
[TypeScript example](https://developers.grvt.io/downloads/examples/typescript/examples/quickstart.ts).

## Documentation

- [TypeScript SDK](https://developers.grvt.io/sdks/typescript): calls, streams, orders, errors, options
- [Quickstart](https://developers.grvt.io/guides/quickstart)
- [Signing](https://developers.grvt.io/guides/signing)
- [Errors and retries](https://developers.grvt.io/guides/errors-and-retries)
- [Recovery recipes](https://developers.grvt.io/guides/recovery)
- [WebSocket](https://developers.grvt.io/guides/websocket)
- [API reference](https://developers.grvt.io/reference/index)

## TypeScript notes

- **Node 22+ and ESM only.** HTTP and WebSocket use the global `fetch` and `WebSocket`. The only runtime
  dependencies are `@noble/curves` and `@noble/hashes`.
- **Browsers get public data only.** Private calls, private streams and orders need the login cookie, and
  browsers neither let code read it nor send it on a WebSocket. Run those from Node.
- **Names:** methods are camelCase (`create_order` is `client.createOrder`, streams end in `Stream`); request
  and response fields keep their snake_case wire names (`sub_account_id`).
- **64-bit integers are strings** (IDs, sequence numbers). Compare them with `BigInt(...)`, not as strings.
- **Short field names on the wire by default** (lite encoding); your code still uses full names. A custom
  `Environment` whose WebSocket URLs don't end in `/ws/full` needs `mdWsLiteUrl` and `tdWsLiteUrl`
  ([details](RUNTIME_API.md#lite-encoding)).

## Known limitations

- Private calls, private streams and orders don't work in the browser.
- No client heartbeat: a quiet but dead connection is noticed only when TCP gives up.
- A rejected WebSocket handshake (401/403) is retried like a network error, because the global `WebSocket`
  hides the HTTP status.
- Private streams can't resume from a sequence number; fill missed events from REST history.
- Login is by API key only; wallet login is not supported.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for the generator-runtime contract, [RUNTIME_API.md](RUNTIME_API.md).

## License

MIT. See [LICENSE](LICENSE).

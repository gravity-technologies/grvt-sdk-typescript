// Public testnet data by default. --trade places one real order which may fill.
import { randomBytes } from "node:crypto";
import { Grvt, Decimal, OrderStateUnknown, PrivateKeySigner, resolveOrder } from "grvt";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`missing ${name} value`);
  return args[i + 1];
};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--trade") continue;
  if (!["--instrument", "--max-notional", "--fixture-url"].includes(args[i]))
    throw new Error(`unknown option ${args[i]}`);
  i++;
}
const trade = args.includes("--trade");
const instrument = option("--instrument", "BTC_USDT_Perp");
const fixture = option("--fixture-url", "");
let env: NonNullable<ConstructorParameters<typeof Grvt>[0]>["env"] = "testnet";
let encoding: "full" | "lite" = "lite";
if (fixture) {
  const url = new URL(fixture);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.port
  )
    throw new Error("fixture URL must be an HTTP loopback origin");
  env = {
    name: "fixture",
    mdUrl: fixture,
    tdUrl: fixture,
    edgeUrl: fixture,
    mdWsUrl: fixture.replace("http:", "ws:"),
    tdWsUrl: fixture.replace("http:", "ws:"),
    chainId: 326,
  };
  encoding = "full"; // the local fixture gateway speaks full names only
}
// Keep arithmetic exact: Decimal is a wire value, while BigInt calculates tick counts.
function fraction(text: string) {
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("expected a positive plain decimal");
  const [whole, tail = ""] = text.split(".");
  return { n: BigInt(whole + tail), d: 10n ** BigInt(tail.length), scale: tail.length };
}
function multiple(text: string, count: bigint) {
  const { n, scale } = fraction(text);
  const digits = (n * count).toString().padStart(scale + 1, "0");
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
const cap = fraction(option("--max-notional", "200"));
if (cap.n <= 0n) throw new Error("max-notional must be positive");
let credentials = {};
const account = process.env.GRVT_SUB_ACCOUNT_ID ?? "";
if (trade) {
  if (
    !process.env.GRVT_API_KEY?.trim() ||
    !process.env.GRVT_PRIVATE_KEY?.trim() ||
    !/^\d+$/.test(account) ||
    BigInt(account) <= 0n ||
    BigInt(account) >= 1n << 64n
  )
    throw new Error(
      "trading requires GRVT_API_KEY, GRVT_PRIVATE_KEY and a positive uint64 GRVT_SUB_ACCOUNT_ID",
    );
  credentials = {
    apiKey: process.env.GRVT_API_KEY,
    signer: new PrivateKeySigner(process.env.GRVT_PRIVATE_KEY),
  };
}
const deadline = setTimeout(() => {
  console.error(
    "deadline reached; retain any printed client_order_id and reconcile; do not resend",
  );
  process.exit(2);
}, 60_000);
const client = new Grvt({ env, encoding, httpAttemptTimeoutMs: 5000, ...credentials });
try {
  const ticker = (await client.ticker({ instrument })).result;
  const metadata = (await client.getInstrument({ instrument })).result;
  console.log("mark price", ticker.mark_price?.toString());
  if (trade) {
    const bid = fraction(ticker.best_bid_price?.toString() ?? "0");
    const tick = fraction(metadata.tick_size.toString());
    const step = fraction(metadata.min_size.toString());
    if (!tick.n || !step.n) throw new Error("instrument has no usable tick or size");
    const ticks = (bid.n * tick.d) / (bid.d * tick.n) - 1n;
    if (ticks <= 0n) throw new Error("instrument has no usable bid");
    const price = multiple(metadata.tick_size.toString(), ticks);
    const p = fraction(price);
    const minimum = fraction(metadata.min_notional.toString());
    const numerator = minimum.n * p.d * step.d;
    const denominator = minimum.d * p.n * step.n;
    const count = (numerator + denominator - 1n) / denominator;
    const size = multiple(metadata.min_size.toString(), count > 0n ? count : 1n);
    const s = fraction(size);
    if (p.n * s.n * cap.d > cap.n * p.d * s.d)
      throw new Error("minimum order exceeds max-notional; no order sent");
    const id = (randomBytes(8).readBigUInt64BE() | (1n << 63n)).toString();
    console.log("client_order_id", id, "price", price, "size", size);
    try {
      await client.createOrder({
        order: {
          sub_account_id: account,
          time_in_force: "GOOD_TILL_TIME",
          post_only: true,
          legs: [
            {
              instrument,
              size: new Decimal(size),
              limit_price: new Decimal(price),
              is_buying_asset: true,
            },
          ],
          metadata: { client_order_id: id },
        },
      });
    } catch (error) {
      if (!(error instanceof OrderStateUnknown)) throw error;
      console.log("create outcome unknown; looking up the same ID");
    }
    let cancelled = false;
    process.exitCode = 2;
    for (let attempt = 0; attempt < 8; attempt++) {
      let found;
      try {
        found = await resolveOrder(client, { sub_account_id: account, client_order_id: id });
      } catch {
        console.log("lookup unavailable; continuing bounded observation");
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (found.status === "found") {
        const status = found.order.state?.status;
        console.log("order status", status);
        if (status === "CANCELLED" || status === "FILLED" || status === "REJECTED") {
          process.exitCode = status === "REJECTED" ? 3 : 0;
          break;
        }
        if (status === "OPEN" && !cancelled) {
          cancelled = true;
          try {
            await client.cancelOrder({ sub_account_id: account, client_order_id: id });
          } catch {
            console.log("cancel response unavailable; observing without retry");
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (process.exitCode === 2)
      console.log(
        "outcome still unknown; retain client_order_id and reconcile manually; do not resend",
      );
  }
} finally {
  await client.close();
  clearTimeout(deadline);
}

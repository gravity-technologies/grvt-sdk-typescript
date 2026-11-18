// Decoding and encoding on the hot paths. Run with `npm run bench`.
// - a 1.2 KB v1.book.d frame (10 + 10 levels): JSON.parse alone, then JSON.parse + decode
// - the same frame through a live subscription: socket message -> parse -> route -> sequence -> decode -> queue
// - a create_order request (2 legs, signed) through the request encoder
// Next to vitest's ops/s it prints the heap allocated per call (measured between forced GCs).

import { bench, describe } from "vitest";
import { Decimal, Grvt, specs, Timestamp } from "../src/index.js";
import { decode } from "../src/generated/codec.js";
import { FakeGateway, FakeHttp } from "../test/fakes.js";

const OPTS = { time: 3000, warmupTime: 500 };

function level(i: number, side: number) {
  const price = (65_000 + side * (i + 1) * 0.5).toFixed(1);
  return { price, size: (1.234 + i * 0.111).toFixed(3), num_orders: 1 + (i % 7) };
}

const feed = {
  event_time: "1730000000123456789",
  instrument: "BTC_USDT_Perp",
  bids: Array.from({ length: 10 }, (_, i) => level(i, -1)),
  asks: Array.from({ length: 10 }, (_, i) => level(i, 1)),
};

function bookFrame(seq: number): string {
  return JSON.stringify({
    stream: "v1.book.d",
    selector: "BTC_USDT_Perp@500",
    sequence_number: String(seq),
    prev_sequence_number: String(seq - 1),
    feed,
  });
}

const BOOK = bookFrame(1000);
const FEED_TYPE = "WSOrderbookLevelsFeedDataV1";

const order = {
  order: {
    sub_account_id: "8289849667772468",
    is_market: false,
    time_in_force: "GOOD_TILL_TIME",
    post_only: false,
    reduce_only: false,
    legs: [
      {
        instrument: "BTC_USDT_Perp",
        size: new Decimal("1.5"),
        limit_price: new Decimal("65000.1"),
        is_buying_asset: true,
      },
      {
        instrument: "ETH_USDT_Perp",
        size: new Decimal("2"),
        limit_price: new Decimal("3000"),
        is_buying_asset: false,
      },
    ],
    signature: {
      signer: "0x" + "ab".repeat(20),
      r: "0x" + "12".repeat(32),
      s: "0x" + "34".repeat(32),
      v: 27,
      expiration: new Timestamp(1_730_000_000_000_000_000n),
      nonce: 1234567,
      chain_id: "326",
    },
    metadata: { client_order_id: "1234567890" },
  },
};
const encodeOrder = specs.ORDER_CREATE_ORDER.encode!;

// A live subscription on the in-memory gateway; frames are handed to the socket's onmessage directly.
const gw = new FakeGateway();
const client = new Grvt({ env: gw.env(), webSocket: gw.factory, http: new FakeHttp() });
const subscription = await client
  .orderbookDeltaStream({ instrument: "BTC_USDT_Perp", rate: 500 })
  .subscribe();
const socket = gw.conns.find((c) => c.subs.size > 0)!;
const queue = (subscription as unknown as { sub: { shift(): unknown; length: number } }).sub;
// Frame texts made up front so the loop measures the client, not JSON.stringify.
const FRAMES = Array.from({ length: 4096 }, (_, i) => bookFrame(i + 1));
let seq = 0;
let frames = 0;
function deliver(): void {
  if (seq === FRAMES.length) {
    // start again from a fresh sequence: the gateway's re-subscribe is not part of the measurement
    (queue as unknown as { seq: { last: bigint } }).seq.last = 0n;
    seq = 0;
  }
  socket.onmessage!({ data: FRAMES[seq++]! });
}
function streamOne(): void {
  deliver();
  if (queue.length > 0) queue.shift();
  frames++;
}

// The frames must really reach the queue, decoded, or the stream bench measures nothing.
while (queue.length > 0) queue.shift();
deliver();
const first = queue.shift() as { feed?: { bids?: { price?: unknown }[] } } | undefined;
if (!(first?.feed?.bids?.[0]?.price instanceof Decimal))
  throw new Error("stream bench: the frame was not delivered and decoded");

/** Bytes allocated per call: heap growth over a batch small enough not to trigger a GC. */
function heapPerOp(name: string, fn: () => unknown): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return;
  const n = 200;
  for (let i = 0; i < 2000; i++) fn();
  const samples: number[] = [];
  for (let r = 0; r < 15; r++) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    samples.push((process.memoryUsage().heapUsed - before) / n);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name}: ~${Math.round(samples[7]!)} bytes allocated per call`);
}

heapPerOp("book frame: JSON.parse", () => JSON.parse(BOOK));
heapPerOp("book frame: JSON.parse + decode", () => decode(JSON.parse(BOOK), FEED_TYPE));
heapPerOp("book frame: stream path", streamOne);
heapPerOp("create_order: encode", () => encodeOrder(order));

describe("v1.book.d frame, 10 + 10 levels", () => {
  bench(
    "JSON.parse only",
    () => {
      JSON.parse(BOOK);
    },
    OPTS,
  );
  bench(
    "JSON.parse + decode",
    () => {
      decode(JSON.parse(BOOK), FEED_TYPE);
    },
    OPTS,
  );
  bench("stream path: onmessage -> queue", streamOne, OPTS);
});

describe("create_order request, 2 legs", () => {
  bench(
    "encode",
    () => {
      encodeOrder(order);
    },
    OPTS,
  );
});

process.on("exit", () => {
  if (frames > 0 && subscription.dropped > 0) console.log(`dropped ${subscription.dropped}`);
  void client.close();
});

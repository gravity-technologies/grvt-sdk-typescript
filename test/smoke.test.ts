// Read-only, unauthenticated checks against Grvt testnet market data through the generated client, in
// both wire encodings.
// No credentials, nothing authenticated, nothing sent to the trading gateway.
//
//   GRVT_SMOKE=1 npx vitest run test/smoke.test.ts

import { expect, it } from "vitest";
import { type Event, Grvt, type models as m, specs } from "../src/index.js";

it.skipIf(process.env.GRVT_SMOKE !== "1")("testnet market data", { timeout: 60_000 }, async () => {
  const events: Event["type"][] = [];
  const client = new Grvt({
    env: "testnet",
    onEvent: (e) => e.type !== "frame" && events.push(e.type),
  });
  try {
    const inst = await client.getInstrument({ instrument: "BTC_USDT_Perp" });
    expect(inst.result?.instrument_hash).toBe("0x030501");
    expect(inst.result?.base_decimals).toBe(9);

    const all = (await client.getAllInstruments({ is_active: true })).result ?? [];
    expect(all.some((i) => i.instrument === "BTC_USDT_Perp")).toBe(true);
    const currencies = (await client.getCurrency()).result ?? [];
    expect(currencies.some((c) => c.symbol === "USDT")).toBe(true);

    // The WS JSON-RPC `result` is the same as the REST body (raw here, so decode it the same way).
    const overWs = await client.runtime.md.request(
      "v1/instrument",
      '{"instrument":"BTC_USDT_Perp"}',
      false,
    );
    expect(specs.INSTRUMENT_GET_INSTRUMENT.decode!(overWs)).toEqual(inst);

    const ticks: m.WSTickerFeedDataV1[] = [];
    for await (const t of client.tickerDeltaStream({ instrument: "BTC_USDT_Perp", rate: 500 })) {
      ticks.push(t);
      if (ticks.length === 3) break;
    }
    expect(ticks[0]!.sequence_number).toBe("0");
    expect(ticks[0]!.feed?.instrument).toBe("BTC_USDT_Perp");
    expect(ticks[2]!.prev_sequence_number).toBe(ticks[1]!.sequence_number);

    const book: m.WSOrderbookLevelsFeedDataV1[] = [];
    for await (const b of client.orderbookDeltaStream({
      instrument: "BTC_USDT_Perp",
      rate: 500,
    })) {
      book.push(b);
      if (book.length === 3) break;
    }
    expect(book[0]!.sequence_number).toBe("0");
    expect(book[0]!.feed?.bids?.length).toBeGreaterThan(0);

    const snap = await client
      .orderbookSnapStream({ instrument: "BTC_USDT_Perp", rate: 500, depth: 10 })
      .next();
    expect(snap.value?.feed?.bids?.length).toBeGreaterThan(0);

    expect(events).not.toContain("gap");
    console.log(
      `\n  ${all.length} active instruments; ticker seqs ${ticks.map((t) => t.sequence_number)}; ` +
        `book seqs ${book.map((b) => b.sequence_number)}; best bid ${snap.value?.feed?.bids?.[0]?.price}; events ${events}`,
    );
  } finally {
    await client.close();
  }
});

// The same public market data with encoding "lite": decoded results must match the full client's.
it.skipIf(process.env.GRVT_SMOKE !== "1")(
  "testnet market data in lite",
  { timeout: 60_000 },
  async () => {
    const frames = { full: 0, lite: 0, fullBytes: 0, liteBytes: 0 };
    const make = (encoding: "full" | "lite") =>
      new Grvt({
        env: "testnet",
        encoding,
        onEvent: (e) => {
          if (e.type === "frame" && e.direction === "in" && e.raw.includes("v1.book.s")) {
            frames[encoding]++;
            frames[`${encoding}Bytes`] += e.raw.length;
          }
        },
      });
    const full = make("full");
    const lite = make("lite");
    try {
      const want = await full.getInstrument({ instrument: "BTC_USDT_Perp" });
      const got = await lite.getInstrument({ instrument: "BTC_USDT_Perp" });
      expect(got).toEqual(want);
      expect(got.result?.instrument_hash).toBe("0x030501");

      const allFull = (await full.getAllInstruments({ is_active: true })).result ?? [];
      const allLite = (await lite.getAllInstruments({ is_active: true })).result ?? [];
      expect(allLite.map((i) => i.instrument).sort()).toEqual(
        allFull.map((i) => i.instrument).sort(),
      );

      const tick = await lite.tickerSnapStream({ instrument: "BTC_USDT_Perp", rate: 500 }).next();
      expect(tick.value?.feed?.instrument).toBe("BTC_USDT_Perp");

      const books = await Promise.all(
        [full, lite].map(async (c) => {
          const out: m.WSOrderbookLevelsFeedDataV1[] = [];
          for await (const b of c.orderbookSnapStream({
            instrument: "BTC_USDT_Perp",
            rate: 500,
            depth: 10,
          })) {
            out.push(b);
            if (out.length === 3) break;
          }
          return out;
        }),
      );
      const [fb, lb] = books as [m.WSOrderbookLevelsFeedDataV1[], m.WSOrderbookLevelsFeedDataV1[]];
      const shape = (b: m.WSOrderbookLevelsFeedDataV1) => ({
        stream: b.stream,
        selector: b.selector,
        instrument: b.feed?.instrument,
        bids: b.feed?.bids?.length,
        asks: b.feed?.asks?.length,
        keys: Object.keys(b.feed?.bids?.[0] ?? {}).sort(),
      });
      expect(lb.map(shape)).toEqual(fb.map(shape));
      expect(String(lb[0]!.feed?.bids?.[0]?.price)).toMatch(/^[0-9.]+$/);
      console.log(
        `\n  lite book.s frames ${frames.lite} (${frames.liteBytes} B) vs full ${frames.full} (${frames.fullBytes} B): ` +
          `${Math.round((1 - frames.liteBytes / frames.lite / (frames.fullBytes / frames.full)) * 100)}% smaller per frame; ` +
          `best bid full ${fb.at(-1)!.feed?.bids?.[0]?.price} lite ${lb.at(-1)!.feed?.bids?.[0]?.price}`,
      );
    } finally {
      await Promise.all([full.close(), lite.close()]);
    }
  },
);

// Each fixture chooses its expected success or failure path in this shared scenario runner.
/* eslint-disable vitest/no-conditional-expect, vitest/valid-title */
import { loadShared } from "./shared.js";
import { expect, it } from "vitest";
import { BookError, OrderBook } from "../src/orderbook.js";
import { decode } from "../src/generated/codec.js";
import type { WSOrderbookLevelsFeedDataV1 } from "../src/generated/models.js";
interface Step {
  action: "apply" | "reset" | "invalidate" | "gap";
  frame?: unknown;
  reason?: "sequence_mismatch" | "disconnect" | "overflow";
  error?: string;
  bids?: string[];
  asks?: string[];
}
const cases = loadShared("scenarios/orderbook.json") as {
  name: string;
  mode: "delta" | "snapshot";
  steps: Step[];
}[];
for (const scenario of cases)
  it(scenario.name, () => {
    const book = new OrderBook("X", scenario.mode);
    for (const step of scenario.steps) {
      if (step.action === "gap") {
        book.onEvent({
          type: "gap",
          socket: "md",
          stream: "book.d",
          selector: "X@100",
          gap: { reason: step.reason! },
        });
        continue;
      }
      if (step.action === "invalidate") {
        book.invalidate();
        continue;
      }
      const frame = decode(
        step.frame,
        "WSOrderbookLevelsFeedDataV1",
      ) as WSOrderbookLevelsFeedDataV1;
      if (step.error) {
        try {
          book[step.action](frame);
          throw new Error("expected book error");
        } catch (error) {
          expect(error).toBeInstanceOf(BookError);
          expect((error as BookError).reason).toBe(step.error);
          if (step.error === "gap")
            expect((error as BookError).gap).toEqual({
              afterSequence: "101",
              reason: "sequence_mismatch",
            });
        }
        expect(book.ready).toBe(false);
        expect(() => book.snapshot()).toThrow(BookError);
      } else {
        book[step.action](frame);
        const snapshot = book.snapshot();
        expect(snapshot.bids.map((v) => v.price.toString())).toEqual(step.bids);
        expect(snapshot.asks.map((v) => v.price.toString())).toEqual(step.asks);
        expect(snapshot.eventTime.nanoseconds).toBe(1793172225200080949n);
        if (frame.feed.bids?.[0]) frame.feed.bids[0].num_orders = 999;
        if (snapshot.bids[0]) {
          expect(Object.isFrozen(snapshot.bids[0])).toBe(true);
          expect(book.snapshot().bids[0]?.num_orders).toBe(1);
        }
      }
    }
  });
it("invalidates on an early gap and filters other selectors after binding", () => {
  const book = new OrderBook("X");
  const event = {
    type: "gap",
    socket: "md",
    stream: "book.d",
    selector: "X@100",
    gap: { afterSequence: "10", reason: "disconnect" },
  } as const;
  book.onEvent(event);
  const frame = decode(
    cases[0]!.steps[0]!.frame,
    "WSOrderbookLevelsFeedDataV1",
  ) as WSOrderbookLevelsFeedDataV1;
  expect(() => book.apply(frame)).toThrow(BookError);
  book.reset(frame);
  book.onEvent({ ...event, selector: "Y@100" });
  expect(book.ready).toBe(true);
  book.onEvent(event);
  expect(book.ready).toBe(false);
  expect(book.gap).toEqual(event.gap);
});

it("orders adjacent exact prices and merges equivalent decimal spellings", () => {
  const ascending = [
    "9.0100",
    "9.0101",
    "10",
    "9007199254740993.000000000000000001",
    "9007199254740993.000000000000000002",
  ];
  const descending = [...ascending].reverse();
  const prices = ["9.01", ...descending];
  const book = new OrderBook("X");
  const levels = prices.map((price) => ({ price, size: "1", num_orders: 1 }));
  const frame = decode(
    {
      stream: "book.d",
      selector: "X",
      sequence_number: "0",
      prev_sequence_number: "0",
      feed: { instrument: "X", event_time: "1", bids: levels, asks: levels },
    },
    "WSOrderbookLevelsFeedDataV1",
  ) as WSOrderbookLevelsFeedDataV1;
  book.apply(frame);
  const snapshot = book.snapshot();
  expect(snapshot.asks.map((level) => level.price.toString())).toEqual(ascending);
  expect(snapshot.bids.map((level) => level.price.toString())).toEqual(descending);
});

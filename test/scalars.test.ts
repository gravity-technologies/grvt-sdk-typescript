import { describe, expect, it } from "vitest";
import { Decimal, Timestamp } from "../src/runtime/scalars.js";

describe("exact scalars", () => {
  it("preserves every decimal digit and trailing zero", () => {
    const value = new Decimal("12345678901234567890.1234567890");
    expect(JSON.stringify(value)).toBe('"12345678901234567890.1234567890"');
    expect(value.toString()).toBe("12345678901234567890.1234567890");
  });
  it("rejects ambiguous or nonfinite decimal text", () => {
    for (const value of ["", "NaN", "Infinity", "1e3", "0x10", " 1", "01", ".5", "1."]) {
      expect(() => new Decimal(value)).toThrow("decimal must");
    }
  });
  it("keeps nanoseconds until Date conversion", () => {
    const value = new Timestamp(1793172225200080949n);
    expect(JSON.stringify(value)).toBe('"1793172225200080949"');
    expect(value.toDate().getTime()).toBe(1793172225200);
    expect(new Timestamp(-1n).toDate().getTime()).toBe(-1);
    expect(Timestamp.fromDate(new Date(123)).nanoseconds).toBe(123000000n);
  });
  it("rejects out-of-range timestamps", () => {
    expect(() => new Timestamp(1n << 63n)).toThrow("outside");
    expect(() => Timestamp.fromDate(new Date(NaN))).toThrow("invalid Date");
  });
});

it("decodes nested generated models and keeps exact values when copying a request", async () => {
  const { decode } = await import("../src/generated/codec.js");
  const { toWire } = await import("../src/runtime/codec.js");
  const model = decode(
    {
      sub_account_id: "1",
      time_in_force: "GOOD_TILL_TIME",
      legs: [{ instrument: "X", is_buying_asset: false, size: "0.123456789012345678901" }],
      signature: { expiration: "1793172225200080949" },
    },
    "OrderInput",
  ) as import("../src/generated/models.js").OrderInput;
  expect(model.legs?.[0]?.size).toBeInstanceOf(Decimal);
  expect(model.signature?.expiration?.nanoseconds).toBe(1793172225200080949n);
  expect(toWire(model).legs?.[0]?.size).toBe("0.123456789012345678901");
  expect(() =>
    decode({ instrument: "X", is_buying_asset: false, size: "1e3" }, "OrderLeg"),
  ).toThrow("decimal must");
});

it("requires complete models while allowing SDK-filled inputs and nullable lists", async () => {
  const { decode, encode } = await import("../src/generated/codec.js");
  const input = { sub_account_id: "1", time_in_force: "GOOD_TILL_TIME", legs: [] };
  expect(encode(input, "OrderInput")).toEqual(input);
  expect(() => decode(input, "Order")).toThrow("signature is required");
  expect(() => encode({ size: new Decimal("1"), is_buying_asset: false }, "OrderLeg")).toThrow(
    "instrument is required",
  );
  const book = { event_time: "1", instrument: "X", bids: null, asks: [] };
  expect(decode(book, "OrderbookLevels")).toMatchObject({ bids: null, asks: [] });
  expect(() => decode({ event_time: "1", instrument: "X", asks: [] }, "OrderbookLevels")).toThrow(
    "bids is required",
  );
  const frame = {
    stream: "v1.ticker.d",
    selector: "X@500",
    sequence_number: "2",
    prev_sequence_number: "1",
    feed: { mark_price: "1" },
  };
  expect(decode(frame, "PartialWSTickerFeedDataV1")).toMatchObject({
    feed: { mark_price: new Decimal("1") },
  });
  expect(() => decode({ feed: {} }, "PartialWSTickerFeedDataV1")).toThrow("stream is required");
});

it("keeps history filter nanoseconds on the wire", async () => {
  const { encode, decode } = await import("../src/generated/codec.js");
  const time = new Timestamp(1793172225200080949n);
  const wire = encode({ sub_account_id: "123", start_time: time }, "ApiFillHistoryRequest");
  expect(wire).toMatchObject({ start_time: "1793172225200080949" });
  expect(
    (
      decode(
        wire,
        "ApiFillHistoryRequest",
      ) as import("../src/generated/models.js").ApiFillHistoryRequest
    ).start_time,
  ).toEqual(time);
});

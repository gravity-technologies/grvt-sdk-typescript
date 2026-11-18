import { Decimal, Timestamp } from "./scalars.js";

/** Internal signing shape: the values the server receives. */
export type Wire<T> = T extends Decimal | Timestamp
  ? string
  : T extends string | number | boolean | bigint | null | undefined
    ? T
    : T extends readonly (infer Item)[]
      ? Wire<Item>[]
      : T extends object
        ? { [Key in keyof T]: Wire<T[Key]> }
        : T;

/** Make a detached request and apply each exact scalar's string encoding before signing. */
export function toWire<T>(value: T): Wire<T> {
  return JSON.parse(JSON.stringify(value)) as Wire<T>;
}

// Helpers for the per-type decode/encode functions generated in src/generated/codec.ts. The rules
// match the generic walker they replaced (kept as test/reference/codec.ts): null and undefined pass
// through at every level, arrays are checked and copied, objects are copied with unknown fields kept.

/** A shallow copy of a wire object; anything else (arrays included) is rejected. */
export function object(value: unknown, kind: string): Record<string, unknown> {
  if (typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${kind}: expected an object`);
  return { ...(value as Record<string, unknown>) };
}

/** A copy of an array nested `depth` deep, with `item` applied to every leaf. */
export function list(
  value: unknown,
  kind: string,
  depth: number,
  item: (value: unknown) => unknown,
): unknown {
  if (value === null || value === undefined) return value;
  if (!Array.isArray(value)) throw new TypeError(`${kind}: expected an array`);
  return depth > 1
    ? value.map((v: unknown) => list(v, kind, depth - 1, item))
    : value.map((v: unknown) => item(v));
}

/** Leaves a value as is (array items of a kind with nothing to convert). */
export function same(value: unknown): unknown {
  return value;
}

export function decimal(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") throw new TypeError("decimal must be a string");
  return new Decimal(value);
}

const NANOS = /^-?[0-9]+$/;

export function timestamp(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string" || !NANOS.test(value)) {
    throw new TypeError("timestamp must be a string of Unix nanoseconds");
  }
  return new Timestamp(BigInt(value));
}

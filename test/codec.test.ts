// The generated per-type decode/encode functions (src/generated/codec.ts) must give exactly what the
// generic schema walker they replaced gives (test/reference/codec.ts): the same values, the same key
// order, and the same error for every bad input. Samples are derived from every contract type.

import { describe, expect, it } from "vitest";
import { Decimal, Timestamp } from "../src/index.js";
import { decode, encode } from "../src/generated/codec.js";
import { SCHEMA } from "../src/generated/codec-schema.js";
import { referenceDecode, referenceEncode } from "./reference/codec.js";

type Dir = "decode" | "encode";
type Field = readonly [string, number, string, boolean, boolean];

const NAMES = Object.keys(SCHEMA);

/** A printable form that keeps key order and scalar classes, so equal output means identical output. */
function show(v: unknown): string {
  if (v instanceof Decimal) return `D(${v})`;
  if (v instanceof Timestamp) return `T(${v})`;
  if (Array.isArray(v)) return `[${v.map(show).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .map(([k, x]) => `${k}:${show(x)}`)
      .join(",")}}`;
  return v === undefined ? "undefined" : JSON.stringify(v);
}

function outcome(fn: () => unknown): string {
  try {
    return "ok " + show(fn());
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
}

/** One valid leaf value; decode gets wire strings, encode gets the SDK's scalar classes. */
function leaf(kind: string, dir: Dir, depthLeft: number): unknown {
  if (kind === "decimal") return dir === "decode" ? "-12.50" : new Decimal("12.5");
  if (kind === "timestamp")
    return dir === "decode" ? "1730000000123456789" : new Timestamp(1730000000123456789n);
  if (SCHEMA[kind]) return depthLeft > 0 ? sample(kind, dir, depthLeft - 1) : {};
  return kind === "enum" ? "SOME_VALUE" : "7";
}

function value(field: Field, dir: Dir, depthLeft: number): unknown {
  const [kind, depth] = field;
  let v: unknown = leaf(kind, dir, depthLeft);
  for (let d = 0; d < depth; d++) v = [v, d === 0 ? null : v];
  return v;
}

/** Every field set (under the name this direction reads), plus an unknown field that must survive. */
function sample(name: string, dir: Dir, depthLeft = 2): Record<string, unknown> {
  const out: Record<string, unknown> = { zz_unknown: 1 };
  for (const [wire, field] of Object.entries(SCHEMA[name]!)) {
    out[dir === "decode" ? wire : field[2]] = value(field, dir, depthLeft);
  }
  return out;
}

/** The sample, then one variant per field and kind of damage. */
function variants(name: string, dir: Dir): (() => unknown)[] {
  const out: (() => unknown)[] = [() => sample(name, dir), () => ({}), () => null, () => [1]];
  out.push(
    () => "text",
    () => 5,
  );
  for (const [wire, field] of Object.entries(SCHEMA[name]!)) {
    const key = dir === "decode" ? wire : field[2];
    const edit = (fn: (o: Record<string, unknown>) => void) => () => {
      const o = sample(name, dir);
      fn(o);
      return o;
    };
    out.push(edit((o) => delete o[key]));
    out.push(edit((o) => (o[key] = null)));
    out.push(edit((o) => (o[key] = undefined)));
    out.push(edit((o) => (o[key] = 42)));
    out.push(edit((o) => (o[key] = "1e3")));
    out.push(edit((o) => (o[key] = "not a time")));
    out.push(edit((o) => (o[key] = [])));
    out.push(edit((o) => (o[key] = [null, "1"])));
    out.push(edit((o) => (o[key] = {})));
    out.push(edit((o) => (o[key] = [{}])));
    // the other direction's spelling of the field
    out.push(
      edit((o) => {
        o[dir === "decode" ? field[2] : wire] = o[key];
        delete o[key];
      }),
    );
  }
  return out;
}

describe.each(["decode", "encode"] as const)("generated %s", (dir) => {
  const generated = dir === "decode" ? decode : encode;
  const reference = dir === "decode" ? referenceDecode : referenceEncode;

  it("matches the reference walker on every contract type and its damaged variants", () => {
    let checked = 0;
    const mismatches: { name: string; input: string; got: string; want: string }[] = [];
    for (const name of NAMES) {
      for (const make of variants(name, dir)) {
        const want = outcome(() => reference(make(), name));
        const got = outcome(() => generated(make(), name));
        if (got !== want) mismatches.push({ name, input: show(make()), got, want });
        checked++;
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(5000);
  });

  it("treats names that are not types like the reference", () => {
    for (const name of ["decimal", "timestamp", "primitive", "enum", "NoSuchType"]) {
      for (const input of ["1.5", "17", null, undefined, { a: 1 }, [1], new Decimal("2")]) {
        expect(outcome(() => generated(input, name))).toBe(outcome(() => reference(input, name)));
      }
    }
  });

  it("does not change its input", () => {
    for (const name of NAMES) {
      const input = sample(name, dir);
      const before = show(input);
      outcome(() => generated(input, name));
      expect(show(input)).toBe(before);
    }
  });
});

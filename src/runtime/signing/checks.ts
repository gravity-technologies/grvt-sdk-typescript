// Order checks: instrument limits (tick, minimum size, size step, minimum notional) checked before signing.
//
// The rules come from the contract (`order_checks`) through the generated ORDER_CHECKS table; this module
// only applies them. Values are compared as exact integers, scaled like the signed fields. Nothing is ever
// rounded or changed: a failing order throws OrderOutOfBounds, with the nearest valid values.

import { DecimalError, OrderOutOfBounds, SigningError } from "../errors.js";
import { scaleDecimal } from "./wire.js";
import type { Meta } from "./wire.js";

/** One contract rule (see contract.json `order_checks.rules`). */
export interface OrderCheckRule {
  readonly field: string;
  readonly times?: string;
  readonly check: "at_least" | "multiple_of";
  readonly limit: string;
  readonly skipIf: readonly string[];
  readonly serverCode: number;
}

/** The generated ORDER_CHECKS table. A scale is fixed decimals, or "base_decimals" (the instrument's). */
export interface OrderChecks {
  readonly legs: string;
  readonly instrument: string;
  readonly scales: Readonly<Record<string, number | "base_decimals">>;
  readonly rules: readonly OrderCheckRule[];
}

const U64_MAX = (1n << 64n) - 1n;

type Obj = Record<string, unknown>;

function dig(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[k];
  }
  return cur;
}

/** n / 10^d without trailing zeros: (60000100000000n, 9) -> "60000.1". */
function fmt(n: bigint, d: number): string {
  if (d === 0) return n.toString();
  const s = n.toString().padStart(d + 1, "0");
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Throw OrderOutOfBounds for the first leg value outside its instrument's limits (SigningError when malformed). */
export function checkOrder(
  checks: OrderChecks,
  order: unknown,
  meta: Pick<Meta, "instrument">,
): void {
  if (!order || typeof order !== "object") return;
  const legs = (order as Obj)[checks.legs];
  if (!Array.isArray(legs)) return;
  legs.forEach((leg: Obj, index) => {
    const name = leg[checks.instrument] as string | undefined;
    const inst = meta.instrument(name);
    const decimals = (field: string) => {
      const s = checks.scales[field];
      return s === "base_decimals" ? inst.base_decimals : (s as number);
    };
    const value = (field: string): bigint | undefined => {
      const raw = leg[field];
      if (raw === undefined || raw === null || raw === "") return undefined;
      let n: bigint;
      try {
        n = scaleDecimal(String(raw), decimals(field));
      } catch (e) {
        throw e instanceof DecimalError ? e.withAt(`OrderLeg.${field}`) : e;
      }
      if (n < 0n || n > U64_MAX)
        throw new SigningError(`OrderLeg.${field}: ${String(raw)} is out of range`);
      return n;
    };
    const limit = (field: string, d: number): bigint => {
      const raw = inst.limits?.[field];
      if (raw === undefined || raw === "") return 0n;
      try {
        return scaleDecimal(raw, d);
      } catch (e) {
        throw e instanceof DecimalError ? e.withAt(`instrument ${name} ${field}`) : e;
      }
    };
    const skipped = (r: OrderCheckRule) => r.skipIf.some((p) => dig(order, p) === true);

    for (const field of Object.keys(checks.scales)) value(field); // a malformed value is reported as such
    for (const rule of checks.rules) {
      if (skipped(rule)) continue;
      let v = value(rule.field);
      if (v === undefined) continue;
      let d = decimals(rule.field);
      let label = rule.field;
      if (rule.times) {
        const t = value(rule.times);
        if (t === undefined || v === 0n || t === 0n) continue;
        v *= t;
        d += decimals(rule.times);
        label = `${rule.field} * ${rule.times}`;
      }
      const lim = limit(rule.limit, d);
      if (lim === 0n) continue;
      let nearest: bigint[];
      let nd = d;
      let msg: string;
      if (rule.check === "at_least") {
        if (v >= lim) continue;
        if (!rule.times) {
          nearest = [lim];
          msg = `${label} ${fmt(v, d)} is below ${rule.limit} ${fmt(lim, d)}`;
        } else {
          nd = decimals(rule.times);
          let x = ceilDiv(lim, value(rule.field)!);
          for (const r2 of checks.rules) {
            if (r2.field !== rule.times || r2.times || skipped(r2)) continue;
            const l2 = limit(r2.limit, nd);
            if (l2 === 0n) continue;
            if (r2.check === "at_least") x = x < l2 ? l2 : x;
            else x = ceilDiv(x, l2) * l2;
          }
          nearest = [x];
          msg = `${label} = ${fmt(v, d)} is below ${rule.limit} ${fmt(lim, d)} (smallest ${rule.times} at this ${rule.field}: ${fmt(x, nd)})`;
        }
      } else {
        if (v % lim === 0n) continue;
        const lo = v - (v % lim);
        nearest = [lo, lo + lim].filter((n) => n > 0n);
        msg = `${label} ${fmt(v, d)} isn't a multiple of ${rule.limit} ${fmt(lim, d)} (nearest: ${nearest.map((n) => fmt(n, d)).join(" or ")})`;
      }
      throw new OrderOutOfBounds(`${name}: ${msg}`, {
        instrument: name ?? "",
        leg: index,
        field: label,
        check: rule.check,
        limit: rule.limit,
        value: fmt(v, d),
        limitValue: fmt(lim, d),
        nearest: nearest.map((n) => fmt(n, nd)),
        serverCode: rule.serverCode,
      });
    }
  });
}

/** Every instrument named by a leg anywhere in a request. */
export function legInstruments(
  obj: unknown,
  legs = "legs",
  instrument = "instrument",
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(obj)) {
    for (const v of obj) legInstruments(v, legs, instrument, out);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Obj)) {
      if (k === legs && Array.isArray(v)) {
        for (const l of v) {
          const name = l && typeof l === "object" ? (l as Obj)[instrument] : undefined;
          if (typeof name === "string" && name) out.add(name);
        }
      } else legInstruments(v, legs, instrument, out);
    }
  }
  return out;
}

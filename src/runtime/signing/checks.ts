import { DecimalError, OrderOutOfBounds, SigningError } from "../errors.js";
import { scaleDecimal } from "./wire.js";
import type { InstrumentMeta } from "./wire.js";

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

export interface OrderIssue {
  readonly leg: number;
  readonly field: string;
  readonly error: SigningError | OrderOutOfBounds;
}

interface OrderMetadata {
  instrument(
    name: string | undefined,
  ): Pick<InstrumentMeta, "base_decimals" | "limits"> | undefined;
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
export function checkOrder(checks: OrderChecks, order: unknown, meta: OrderMetadata): void {
  if (!meta) throw new SigningError("checkOrder requires instrument metadata");
  for (const issue of orderIssues(checks, order, meta)) {
    throw issue.error;
  }
}

/** Inspect each leg in order. Omit metadata to check fixed-scale fields only. */
export function* orderIssues(
  checks: OrderChecks,
  order: unknown,
  meta?: OrderMetadata,
): Generator<OrderIssue> {
  if (!order || typeof order !== "object") return;
  const legs = (order as Obj)[checks.legs];
  if (!Array.isArray(legs)) return;
  for (let index = 0; index < legs.length; index++) {
    if (!(index in legs)) continue;
    const leg = legs[index] as Obj;
    const name = leg[checks.instrument] as string | undefined;
    const inst = meta?.instrument(name);
    if (meta && !inst)
      throw new SigningError(`no metadata for instrument ${JSON.stringify(name ?? "")}`);
    if (inst && (!Number.isSafeInteger(inst.base_decimals) || inst.base_decimals < 0))
      throw new SigningError(`invalid base_decimals for instrument ${JSON.stringify(name ?? "")}`);
    const values = new Map<string, { value: bigint; decimals: number }>();
    for (const [field, scale] of Object.entries(checks.scales)) {
      const decimals = scale === "base_decimals" ? inst?.base_decimals : scale;
      const raw = leg[field];
      if (decimals === undefined || raw === undefined || raw === null || raw === "") continue;
      try {
        const value = scaleDecimal(String(raw), decimals);
        if (value < 0n || value > U64_MAX)
          throw new SigningError(`OrderLeg.${field}: ${String(raw)} is out of range`);
        values.set(field, { value, decimals });
      } catch (error) {
        if (!(error instanceof SigningError)) throw error;
        yield {
          leg: index,
          field,
          error: error instanceof DecimalError ? error.withAt(`OrderLeg.${field}`) : error,
        };
      }
    }
    if (!inst?.limits) continue;
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

    for (const rule of checks.rules) {
      if (skipped(rule)) continue;
      const amount = values.get(rule.field);
      if (!amount) continue;
      let v = amount.value;
      let d = amount.decimals;
      let label = rule.field;
      if (rule.times) {
        const t = values.get(rule.times);
        if (!t || v === 0n || t.value === 0n) continue;
        v *= t.value;
        d += t.decimals;
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
          nd = values.get(rule.times)!.decimals;
          let x = ceilDiv(lim, amount.value);
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
      yield {
        leg: index,
        field: label,
        error: new OrderOutOfBounds(`${name}: ${msg}`, {
          instrument: name ?? "",
          leg: index,
          field: label,
          check: rule.check,
          limit: rule.limit,
          value: fmt(v, d),
          limitValue: fmt(lim, d),
          nearest: nearest.map((n) => fmt(n, nd)),
          serverCode: rule.serverCode,
        }),
      };
    }
  }
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

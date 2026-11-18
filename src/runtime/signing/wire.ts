// Helpers the generated sign functions call: one per contract transform (see contract.json
// `signed.transforms`). Errors are SigningError and always happen before anything is signed.

import { ConfigError, DecimalError, SigningError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import type { Message, MessageValue, StructType } from "./eip712.js";
import type { Signature } from "./signer.js";

type Scalar = string | number | bigint | boolean | null | undefined;

const absent = (v: Scalar) => v === undefined || v === null || v === "";

/** `copy`, `sig.nonce`, `sig.expiration`: the wire value as the EIP-712 type, or `def` when absent. */
export function copy(
  value: Scalar,
  eipType: string,
  at: string,
  def?: string | boolean | number,
): MessageValue {
  let v: Scalar = value;
  if (absent(v)) {
    if (def === undefined) throw new SigningError(`${at} is required for signing`);
    v = def;
  }
  if (eipType === "bool") return typeof v === "string" ? v.toLowerCase() === "true" : Boolean(v);
  if (eipType === "address") return toAddress(String(v), at);
  if (eipType === "string") return String(v);
  if (/^u?int\d+$/.test(eipType)) return toInt(v as string | number | bigint | boolean, at);
  throw new SigningError(`${at}: unsupported copy type ${eipType}`);
}

/** `address`: absent is the zero address. */
export function address(value: string | undefined, at: string): string {
  return absent(value) ? "0x" + "0".repeat(40) : toAddress(value!, at);
}

/** Builder-style variant rules: is this address set to something other than zero? */
export function addressSet(value: string | undefined): boolean {
  if (absent(value)) return false;
  try {
    return BigInt(value!) !== 0n;
  } catch {
    return false;
  }
}

/** `enumCode`: the enum's signed integer. Absent is 0; a value this SDK does not know is an error. */
export function enumCode(
  value: string | undefined,
  codes: Readonly<Record<string, number>>,
  at: string,
): bigint {
  if (absent(value)) return 0n;
  const c = codes[value!];
  if (c === undefined) throw new SigningError(`${at}: unknown enum value ${JSON.stringify(value)}`);
  return BigInt(c);
}

/** `scaled`: decimal string × 10^decimals. Over-precision is rejected, never rounded. */
export function scaled(
  value: string | undefined,
  decimals: number,
  at: string,
  def?: string,
): bigint {
  let s = value;
  if (absent(s)) {
    if (def === undefined) throw new SigningError(`${at} is required for signing`);
    s = def;
  }
  try {
    return scaleDecimal(s!, decimals);
  } catch (e) {
    throw e instanceof DecimalError
      ? e.withAt(at)
      : new SigningError(`${at}: ${(e as Error).message}`);
  }
}

/** "65000.1", 9 -> 65000100000000n. Throws DecimalError (malformed or too precise); never rounds. */
export function scaleDecimal(s: string, decimals: number): bigint {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m || (m[2] === "" && !m[3])) throw new DecimalError("malformed", s, decimals, 0);
  const frac = (m[3] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) throw new DecimalError("precision", s, decimals, frac.length);
  const n = BigInt((m[2] || "0") + frac.padEnd(decimals, "0"));
  return m[1] === "-" ? -n : n;
}

function toInt(v: string | number | bigint | boolean, at: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v))
      throw new SigningError(`${at}: ${v} is not a safe integer; pass it as a string`);
    return BigInt(v);
  }
  const t = v.trim();
  if (!/^(0[xX][0-9a-fA-F]+|[+-]?\d+)$/.test(t))
    throw new SigningError(`${at}: not an integer: ${JSON.stringify(v)}`);
  return BigInt(t);
}

function toAddress(s: string, at: string): string {
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s))
    throw new SigningError(`${at}: not an address: ${JSON.stringify(s)}`);
  return s.toLowerCase();
}

// -- metadata ----------------------------------------------------------------------------------

/** What signing needs from an instrument (from get_instrument). */
export interface InstrumentMeta {
  instrument_hash: string;
  base_decimals: number;
  /** Decimals of the quote currency (instrument_quote_decimals scaling); absent when not loaded. */
  quote_decimals?: number;
  /** The instrument limits the order checks read (tick_size, min_size, min_notional), as decimal strings. */
  limits?: Readonly<Record<string, string | undefined>>;
}

/** What signing needs from a currency (from get_currency). */
export interface CurrencyMeta {
  id: number;
  symbol: string;
  balance_decimals: number;
}

/** The instrument, currency and main-account metadata one sign call needs, already loaded. */
export class Meta {
  readonly instruments = new Map<string, InstrumentMeta>();
  readonly currencies = new Map<string, CurrencyMeta>();
  /** The session's main account address (contract signed.main_account), when the call signs it. */
  mainAccount?: string;

  instrument(name: string | undefined): InstrumentMeta {
    const v = this.instruments.get(name ?? "");
    if (!v) throw new SigningError(`no metadata for instrument ${JSON.stringify(name ?? "")}`);
    return v;
  }

  currency(symbol: string | undefined): CurrencyMeta {
    const v = this.currencies.get(symbol ?? "");
    if (!v) throw new SigningError(`no metadata for currency ${JSON.stringify(symbol ?? "")}`);
    return v;
  }

  /** Scale for `instrument_quote_decimals`. */
  quoteDecimals(name: string | undefined): number {
    const d = this.instrument(name).quote_decimals;
    if (d === undefined)
      throw new SigningError(`no quote_decimals for instrument ${JSON.stringify(name ?? "")}`);
    return d;
  }

  /** `mainAccount`: the session's main account address. */
  mainAccountId(): string {
    if (!this.mainAccount) throw new SigningError("no main account for this session");
    return toAddress(this.mainAccount, "main account");
  }

  /** `assetKey`: the instrument hash as a uint256. */
  assetKey(name: string | undefined): bigint {
    return toInt(this.instrument(name).instrument_hash, "instrument_hash");
  }

  /** `currencyId`. */
  currencyId(symbol: string | undefined): bigint {
    return BigInt(this.currency(symbol).id);
  }
}

/** The non-empty names among `values`, deduplicated in order. */
export function present(values: Iterable<string | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out;
}

/** The items of an optional list (an `each` mapping). */
export function each<T>(list: readonly T[] | undefined): readonly T[] {
  return list ?? [];
}

// -- signature object ----------------------------------------------------------------------------

/** The wire signature object (Signature in the contract). */
export interface WireSignature {
  signer?: string;
  r?: string;
  s?: string;
  v?: number;
  expiration?: string;
  nonce?: number;
  chain_id?: string;
}

/** Fill signer, nonce, expiration and chain_id when absent (expiration "0" counts as absent). */
export function prepareSignature(rt: Runtime, sig: WireSignature, ttlNs: bigint): void {
  const signer = rt.signer;
  if (!signer) throw new ConfigError("this call needs a signer: pass `signer` to the client");
  if (!sig.signer) sig.signer = signer.address;
  if (sig.nonce === undefined || sig.nonce === null) sig.nonce = rt.nonces.nextNonce();
  if (!sig.expiration || sig.expiration === "0")
    sig.expiration = (rt.clock.nowNs() + ttlNs).toString();
  if (!sig.chain_id) sig.chain_id = String(rt.env.chainId);
}

/** Sign with the domain chain id from the signature object (0 or absent = the environment's), then write r/s/v. */
export async function signInto(
  rt: Runtime,
  sig: WireSignature,
  type: StructType,
  message: Message,
): Promise<void> {
  const chainId = sig.chain_id && sig.chain_id !== "0" ? BigInt(sig.chain_id) : undefined;
  const s: Signature = await rt.sign(type, message, chainId);
  sig.signer = s.signer;
  sig.r = s.r;
  sig.s = s.s;
  sig.v = s.v;
}

/** `<primary joined by ->[@<secondary joined by ->]`, skipping fields left unset. */
export function selector(primary: readonly unknown[], secondary: readonly unknown[]): string {
  const join = (xs: readonly unknown[]) =>
    xs
      .filter((x) => x !== undefined && x !== null && x !== "")
      .map(String)
      .join("-");
  const p = join(primary);
  const s = join(secondary);
  return s ? `${p}@${s}` : p;
}

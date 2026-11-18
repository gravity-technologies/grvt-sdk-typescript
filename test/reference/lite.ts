// Reference lite converter (test only), read straight from contract/contract.json and independent of the
// generated table and the runtime codec. The fakes use it to speak lite, and to flag any key a lite client
// sends that is not the lite name of a field of the type it belongs to (a full name sent to a lite path is
// silently read as an absent field by the real server).

import { loadShared } from "../shared.js";

const contract = loadShared("contract/contract.json");
interface Field {
  name: string;
  lite?: string;
  kind: string;
  type: string;
}
const types = new Map<string, Field[]>(
  contract.types.map((t: { name: string; fields: Field[] | null }) => [t.name, t.fields ?? []]),
);
const httpErrorBody = contract.transport.lite.http_error_body as Record<string, string>;

export const LITE_HTTP_PREFIX = "/lite/";
export const FULL_HTTP_PREFIX = "/full/";

/** The contract RPC for a REST path (either encoding) or a WS method. */
export function rpcFor(routeOrMethod: string): { request: string; response: string } | undefined {
  const full = routeOrMethod.replace(LITE_HTTP_PREFIX, FULL_HTTP_PREFIX);
  return contract.rpcs.find(
    (r: { http_path: string; ws_method: string }) =>
      full.endsWith(r.http_path) || routeOrMethod === r.ws_method,
  );
}

/** The feed type of a stream channel. */
export function feedTypeOf(channel: string): string | undefined {
  return contract.streams.find((s: { channel: string }) => s.channel === channel)?.feed_type;
}

/** Full names -> lite names for `type`. Lenient: keys the type does not have are kept (for bad input). */
export function toLite(value: unknown, type: string): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => toLite(v, type));
  const fields = types.get(type);
  if (!fields) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const f = fields.find((x) => x.name === k);
    out[f?.lite ?? k] = f && f.kind === "struct" ? toLite(v, f.type) : v;
  }
  return out;
}

/**
 * Lite names -> full names for `type`. Strict: a key that is not a lite name of `type` is reported in
 * `problems` (with its path) and dropped.
 */
export function toFull(value: unknown, type: string, problems: string[], path = type): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => toFull(v, type, problems, `${path}[${i}]`));
  const fields = types.get(type);
  if (!fields) {
    problems.push(`${path}: unknown type ${type}`);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const f = fields.find((x) => x.lite === k);
    if (!f) {
      problems.push(`${path}: ${JSON.stringify(k)} is not a lite name of ${type}`);
      continue;
    }
    out[f.name] = f.kind === "struct" ? toFull(v, f.type, problems, `${path}.${k}`) : v;
  }
  return out;
}

/** The HTTP error body with lite keys (unknown keys kept). */
export function liteHttpError(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [httpErrorBody[k] ?? k, v]));
}

/** Every key in `value`, at any depth (for "no full name was sent" checks). */
export function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  return out;
}

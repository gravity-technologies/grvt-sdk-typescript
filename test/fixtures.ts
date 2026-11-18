// Complete wire objects for transport tests. Explicit overrides remain unmodified,
// so malformed-response tests can still exercise missing and null fields.
import { loadShared } from "./shared.js";
const contract = loadShared("contract/contract.json");
const types = new Map<string, any>(
  [...contract.types, ...contract.edge.types].map((t: any) => [t.name, t]),
);
const enums = new Map<string, any>(contract.enums.map((e: any) => [e.name, e]));
export function fixture(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const field of types.get(name)?.fields ?? []) {
    if (field.optional) continue;
    result[field.name] = field.array_depth
      ? []
      : field.kind === "struct"
        ? fixture(field.type)
        : field.kind === "enum"
          ? enums.get(field.type).values[0].name
          : field.type === "bool"
            ? false
            : /^(u?int)(8|16|32)$/.test(field.type)
              ? 1
              : field.type === "any"
                ? {}
                : "1";
  }
  return { ...result, ...overrides };
}
export function responseFixture(route: string): Record<string, any> {
  const rpc = contract.rpcs.find((r: any) => route.endsWith(r.http_path) || route === r.ws_method);
  return rpc ? fixture(rpc.response) : {};
}
export function feedFixture(channel: string): unknown {
  const stream = contract.streams.find((s: any) => s.channel === channel);
  const field = types.get(stream?.feed_type)?.fields.find((f: any) => f.name === "feed");
  return field ? (field.array_depth ? [] : fixture(field.type)) : {};
}

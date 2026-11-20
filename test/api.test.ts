// Generated API coverage: every gateway RPC and stream in contract.json has a method on the
// client; every RPC is callable with its required fields (against a fake HTTP transport); every
// stream builds its selector.

import { loadShared } from "./shared.js";
import { describe, expect, it } from "vitest";
import { ConfigError, Grvt, SigningError, specs } from "../src/index.js";
import { fixture } from "./fixtures.js";
import { ENCODINGS, FakeHttp } from "./fakes.js";

const contract = loadShared("contract/contract.json");
const types = new Map<string, any>(
  [...contract.types, ...contract.edge.types].map((t: any) => [t.name, t]),
);
const enums = new Map<string, any>(contract.enums.map((e: any) => [e.name, e]));
const ops = specs.OPERATIONS;

/** A value of the field's wire type, good enough to pass the required-field check. */
function dummy(f: any): unknown {
  if (f.array_depth) return [];
  if (f.kind === "struct") return fixture(f.type);
  if (f.kind === "enum") return enums.get(f.type).values[0].name;
  if (f.type === "bool") return true;
  if (["uint8", "uint16", "uint32", "int8", "int16", "int32"].includes(f.type)) return 1;
  return "1";
}

const rpcSpecs = new Map(
  Object.values(specs)
    .filter((v: any) => v && typeof v === "object" && "method" in v && "orderEntry" in v)
    .map((s: any) => [s.id, s]),
);
const streamSpecs = new Map(
  Object.values(specs)
    .filter((v: any) => v && typeof v === "object" && "stream" in v && "conflate" in v)
    .map((s: any) => [s.id, s]),
);

describe("generated API", () => {
  it("has one method per contract operation", () => {
    const ids = [...contract.rpcs.map((r: any) => r.id), ...contract.streams.map((s: any) => s.id)];
    expect(ops.map((o) => o.id).sort()).toEqual([...ids].sort());
    expect(new Set(ops.map((o) => o.method)).size).toBe(ops.length);
    const client = new Grvt();
    expect("loginApiKey" in client).toBe(false);
    for (const o of ops) expect(typeof (client as any)[o.method], o.id).toBe("function");
    expect(rpcSpecs.size).toBe(contract.rpcs.length + contract.edge.routes.length);
    expect(streamSpecs.size).toBe(contract.streams.length);
  });

  it("names every stream method with a Stream suffix", () => {
    for (const o of ops) expect(o.method.endsWith("Stream"), o.id).toBe(o.kind === "stream");
    expect(ops.filter((o) => o.id === "trade.trade").map((o) => o.method)).toEqual([
      "trade",
      "tradeStream",
    ]);
  });

  it.each(ENCODINGS)("every RPC is reachable with its required fields (%s)", async (encoding) => {
    const http = new FakeHttp({ lite: encoding === "lite" });
    const client = new Grvt({ encoding, apiKey: "k", http });
    let reached = 0;
    for (const op of ops.filter((o) => o.kind !== "stream")) {
      http.calls.length = 0;
      const route =
        contract.rpcs.find((r: any) => r.id === op.id) ??
        contract.edge.routes.find((r: any) => r.id === op.id);
      const req: Record<string, unknown> = {};
      for (const f of types.get(route.request).fields ?? [])
        if (!f.optional) req[f.name] = dummy(f);
      const p = (client as any)[op.method](req);
      // A signed call with no signer configured stops at signing, before anything is sent. Unsigned
      // calls, and per-element bindings with no elements (a pure bulk cancel), reach the gateway.
      const stopsAtSigning = Boolean(route.signs && !route.signs.field.endsWith("[]"));
      const outcome = await p.then(
        // callsTo matches the lite path too; the fake reports a call in the wrong encoding.
        () => (http.callsTo(rpcSpecs.get(op.id)!.path).length === 1 ? "sent" : "wrong url"),
        (e: unknown) =>
          e instanceof ConfigError || e instanceof SigningError ? "stopped at signing" : String(e),
      );
      expect({ id: op.id, outcome }).toEqual({
        id: op.id,
        outcome: stopsAtSigning ? "stopped at signing" : "sent",
      });
      reached++;
    }
    expect(reached).toBe(contract.rpcs.length);
    expect(http.violations).toEqual([]);
  });

  it("every stream builds its selector without touching the network", () => {
    const client = new Grvt({
      webSocket: () => {
        throw new Error("no network");
      },
    });
    for (const op of ops.filter((o) => o.kind === "stream")) {
      const s = contract.streams.find((x: any) => x.id === op.id);
      const sel: Record<string, unknown> = {};
      for (const f of s.selector.primary)
        if (!f.optional) sel[f.name] = f.type === "uint64" ? 42 : "X";
      const sub = (client as any)[op.method](sel);
      expect(sub.stream).toBe(s.channel);
      expect(sub.selector.length).toBeGreaterThan(0);
      expect(() => (client as any)[op.method]({})).toThrow(ConfigError);
    }
  });
});

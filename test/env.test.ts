// A custom Environment is used exactly as given: every URL and the chain id are set independently, and a
// missing one is a ConfigError when the client is built, never a silent fallback to a named environment.

import { describe, expect, it } from "vitest";
import { ConfigError, ENVIRONMENTS, type Environment, Grvt } from "../src/index.js";

const custom: Environment = {
  name: "custom",
  mdUrl: "https://md.gateway.example.com",
  tdUrl: "https://td.gateway.example.com",
  edgeUrl: "https://edge.gateway.example.com",
  mdWsUrl: "wss://md.gateway.example.com/ws/full",
  tdWsUrl: "wss://td.gateway.example.com/ws/full",
  mdWsLiteUrl: "wss://md.gateway.example.com/ws/lite",
  tdWsLiteUrl: "wss://td.gateway.example.com/ws/lite",
  chainId: 4242,
};

describe("custom environment", () => {
  it("is used as given", () => {
    const client = new Grvt({ env: custom });
    expect(client.runtime.env).toEqual(custom);
    expect(client.runtime.domain.chainId).toBe(4242n);
  });

  it("derives the lite WebSocket URLs from the full ones; an explicit one wins", () => {
    const { mdWsLiteUrl: _md, tdWsLiteUrl: _td, ...fullOnly } = custom;
    const derived = new Grvt({ env: fullOnly }).runtime; // lite is the default
    expect(derived.socket("md").url).toBe("wss://md.gateway.example.com/ws/lite");
    expect(derived.socket("td").url).toBe("wss://td.gateway.example.com/ws/lite");
    const explicit = new Grvt({ env: { ...fullOnly, tdWsLiteUrl: "wss://other/lite" } }).runtime;
    expect(explicit.socket("md").url).toBe("wss://md.gateway.example.com/ws/lite");
    expect(explicit.socket("td").url).toBe("wss://other/lite");
  });

  it("reports a lite URL it can't derive when the client is built", () => {
    const { mdWsLiteUrl: _md, tdWsLiteUrl: _td, ...fullOnly } = custom;
    const odd = { ...fullOnly, mdWsUrl: "wss://md.gateway.example.com/stream" };
    expect(() => new Grvt({ env: odd })).toThrow(ConfigError);
    expect(() => new Grvt({ env: odd })).toThrow(/does not end in \/ws\/full.*set mdWsLiteUrl/);
    expect(new Grvt({ env: odd, encoding: "full" }).runtime.env).toEqual(odd);
    const fixed = new Grvt({ env: { ...odd, mdWsLiteUrl: "wss://md/lite" } }).runtime;
    expect(fixed.socket("md").url).toBe("wss://md/lite");
  });

  it("rejects a missing URL or chain id", () => {
    for (const field of ["mdUrl", "tdUrl", "edgeUrl", "mdWsUrl", "tdWsUrl", "chainId"] as const) {
      const env = { ...custom, [field]: field === "chainId" ? 0 : "" };
      expect(() => new Grvt({ env }), field).toThrow(ConfigError);
      expect(() => new Grvt({ env }), field).toThrow(field);
    }
    const { chainId: _, ...noChain } = custom;
    expect(() => new Grvt({ env: noChain as Environment })).toThrow("chainId");
  });

  it("rejects inherited property names as unknown environments", () => {
    for (const env of ["constructor", "__proto__", "toString"])
      expect(() => new Grvt({ env })).toThrow(ConfigError);
  });

  it("names only testnet and production", () => {
    expect(Object.keys(ENVIRONMENTS).sort()).toEqual(["production", "testnet"]);
    expect(() => new Grvt({ env: "prod" })).toThrow(ConfigError);
  });
});

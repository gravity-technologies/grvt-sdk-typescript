// Where the SDK connects and which chain id it signs for. The named environments come from the
// contract (generated ENVIRONMENTS); pass your own Environment for a local gateway or a test server.

import { ConfigError } from "./errors.js";
import type { Gateway } from "./spec.js";

export interface Environment {
  readonly name: string;
  /** Market-data gateway, REST. */
  readonly mdUrl: string;
  /** Trading gateway, REST. */
  readonly tdUrl: string;
  /** Edge: login. */
  readonly edgeUrl: string;
  readonly mdWsUrl: string;
  readonly tdWsUrl: string;
  /**
   * WebSocket URLs for clients with encoding "lite". Unset, each is the full URL with its ending `/ws/full`
   * swapped for `/ws/lite`; set one only when that rule does not fit.
   */
  readonly mdWsLiteUrl?: string;
  readonly tdWsLiteUrl?: string;
  /** EIP-712 domain chainId. */
  readonly chainId: number;
  /**
   * Largest WS frame the gateway accepts. The deployed value is not published yet, so the named
   * environments leave it unset (no check).
   */
  readonly wsMaxFrameBytes?: number;
}

const FULL_WS_PATH = "/ws/full";
const LITE_WS_PATH = "/ws/lite";

export function resolveEnv(
  env: string | Environment,
  named: Readonly<Record<string, Environment>>,
  lite = false,
): Environment {
  if (typeof env !== "string") return validateEnv(env, lite);
  if (!Object.hasOwn(named, env))
    throw new ConfigError(
      `unknown env ${JSON.stringify(env)}; use ${Object.keys(named)
        .map((k) => JSON.stringify(k))
        .join(" or ")} or pass an Environment`,
    );
  return named[env]!;
}

/**
 * Check a custom Environment. Every field is used as given: nothing falls back to a named environment, so an
 * empty URL or a chain id that is not a positive integer is a ConfigError, not a default. For lite, it also
 * throws when a lite WebSocket URL can't be derived (see wsUrl).
 */
export function validateEnv(env: Environment, lite = false): Environment {
  const urls = ["mdUrl", "tdUrl", "edgeUrl", "mdWsUrl", "tdWsUrl"] as const;
  const missing: string[] = urls.filter((k) => typeof env[k] !== "string" || env[k].trim() === "");
  if (!Number.isSafeInteger(env.chainId) || env.chainId <= 0) missing.push("chainId");
  if (missing.length > 0)
    throw new ConfigError(
      `environment ${JSON.stringify(env.name)} is missing ${missing.join(", ")}: a custom Environment must set every URL and the chain id`,
    );
  if (lite) for (const g of ["md", "td"] as const) wsUrl(env, g, true);
  return env;
}

export function restUrl(env: Environment, gateway: Gateway, path: string): string {
  const base = gateway === "md" ? env.mdUrl : gateway === "td" ? env.tdUrl : env.edgeUrl;
  return base + path;
}

/**
 * The gateway's WebSocket URL. For lite it is the explicit lite URL when set, else the full URL with its
 * ending `/ws/full` swapped for `/ws/lite`; a full URL without that ending is a ConfigError.
 */
export function wsUrl(env: Environment, gateway: Gateway, lite = false): string {
  const url = gateway === "md" ? env.mdWsUrl : env.tdWsUrl;
  if (!lite) return url;
  const field = gateway === "md" ? "mdWsLiteUrl" : "tdWsLiteUrl";
  const explicit = env[field];
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  if (!url.endsWith(FULL_WS_PATH))
    throw new ConfigError(
      `environment ${JSON.stringify(env.name)}: ${url} does not end in ${FULL_WS_PATH}, so it has no lite URL; set ${field}`,
    );
  return url.slice(0, -FULL_WS_PATH.length) + LITE_WS_PATH;
}

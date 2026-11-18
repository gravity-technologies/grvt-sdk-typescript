// The test data every SDK shares: the contract (contract/) and the scenarios (scenarios/). Both live in the
// monorepo's sdk/ folder, found by walking up from here. To run the tests from a copy of this SDK outside the
// monorepo, set GRVT_SDK_SHARED to a folder that holds contract/ and scenarios/.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sharedRoot(): string {
  const env = process.env.GRVT_SDK_SHARED;
  if (env) return resolve(env);
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "contract", "contract.json")) && existsSync(join(dir, "scenarios")))
      return dir;
    if (dirname(dir) === dir)
      throw new Error("no contract/ and scenarios/ above this SDK; set GRVT_SDK_SHARED");
  }
}

const SHARED = sharedRoot();

/** Parses a shared JSON file, e.g. loadShared("scenarios/orderbook.json"). */
export function loadShared(path: string): any {
  return JSON.parse(readFileSync(join(SHARED, path), "utf8"));
}

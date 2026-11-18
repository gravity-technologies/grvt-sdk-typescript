// Validate the fresh tarball manifest and isolated installation prepared by check-quickstarts.py.
// The same installation runs CJS/ESM checks and the canonical quickstart.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dirname, "..");
const tsrs = join(pkgDir, "node_modules", ".bin", "tsrs");
const dir = process.argv[2];
if (!dir) throw new Error("run python3 sdk/scripts/check-quickstarts.py --language typescript");
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });

const [{ files }] = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
const allowed = /^(dist\/.+\.(js|d\.ts)|README\.md|RUNTIME_API\.md|LICENSE|package\.json)$/;
const stray = files.map((f) => f.path).filter((p) => !allowed.test(p));
if (stray.length > 0) throw new Error(`unexpected files in the package: ${stray.join(", ")}`);
for (const want of ["dist/index.d.ts", "dist/generated/client.js", "dist/generated/models.d.ts"]) {
  if (!files.some((f) => f.path === want)) throw new Error(`${want} missing from the package`);
}

run("node", [
  "-e",
  "const g = require('grvt'); if (typeof g.Grvt !== 'function') throw new Error('require: no Grvt');",
]);
run("node", [
  "--input-type=module",
  "-e",
  "const g = await import('grvt'); if (typeof g.Grvt !== 'function') throw new Error('import: no Grvt');",
]);

writeFileSync(
  join(dir, "cjs.cts"),
  'import grvt = require("grvt");\nexport const client: grvt.Grvt = new grvt.Grvt();\nexport type O = grvt.models.Order;\n',
);
writeFileSync(
  join(dir, "esm.mts"),
  'import { Grvt, type models } from "grvt";\nexport const client: Grvt = new Grvt();\nexport type O = models.Order;\n',
);
run(tsrs, ["--noEmit", "--strict", "--module", "nodenext", "--types", "", "cjs.cts", "esm.mts"]);
console.log("package ok: require, import and CJS/ESM type resolution");

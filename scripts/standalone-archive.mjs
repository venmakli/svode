#!/usr/bin/env node
// The standalone Svode runtime as one local archive: the `svode`, `svode-mcp`
// and `svode-lfs` binaries of <bin dir> next to the plugin payload of the
// same product version.
//
//   svode-<version>-<target triple>/
//     bin/svode, bin/svode-mcp, bin/svode-lfs, bin/svode-launcher
//     plugins/svode/
//
// usage: node scripts/standalone-archive.mjs <bin dir> <out dir>
// Writes <out dir>/svode-<version>-<target triple>.tar.gz and prints its
// path. Needs tar and rustc (for the host target triple). `scripts/install.sh`
// installs the archive.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  buildPayload,
  checkPayload,
  productVersion,
} from "./plugin-payload.mjs";

const RUNTIME = ["svode", "svode-mcp", "svode-lfs", "svode-launcher"];
const [binDir, outDir] = process.argv.slice(2).map((arg) => resolve(arg));
if (!binDir || !outDir) {
  console.error(
    "usage: node scripts/standalone-archive.mjs <bin dir> <out dir>",
  );
  process.exit(2);
}

const version = productVersion();
for (const bin of ["svode", "svode-mcp", "svode-launcher"]) {
  const reported = execFileSync(join(binDir, bin), ["--version"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .pop();
  if (reported !== version) {
    throw new Error(
      `${bin} reports ${reported}, the product version is ${version}`,
    );
  }
}

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .match(/^host:\s*(.+)$/m)[1]
  .trim();
const name = `svode-${version}-${triple}`;
const stage = join(outDir, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });
for (const bin of RUNTIME) {
  const source = join(binDir, bin);
  if (!existsSync(source)) throw new Error(`missing runtime binary ${source}`);
  copyFileSync(source, join(stage, "bin", bin));
  chmodSync(join(stage, "bin", bin), 0o755);
}
buildPayload(join(stage, "plugins/svode"));
checkPayload(join(stage, "plugins/svode"), version);

const archive = join(outDir, `${name}.tar.gz`);
// No AppleDouble `._*` entries from macOS tar.
execFileSync("tar", ["-czf", archive, "-C", outDir, name], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
rmSync(stage, { recursive: true, force: true });
console.log(archive);

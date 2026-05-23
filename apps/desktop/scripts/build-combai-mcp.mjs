#!/usr/bin/env node
// Build the combai-mcp sidecar and place it where Tauri's `externalBin`
// expects: `apps/desktop/src-tauri/binaries/combai-mcp-<target-triple>[.exe]`.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(__dirname, "../src-tauri");
const binariesDir = resolve(crateDir, "binaries");

function rustcHostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = out.match(/^host:\s*(.+)$/m);
  if (!match)
    throw new Error(`could not parse host triple from rustc -vV:\n${out}`);
  return match[1].trim();
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
  }
}

function copyIfChanged(src, dest) {
  if (
    existsSync(dest) &&
    Buffer.compare(readFileSync(src), readFileSync(dest)) === 0
  ) {
    return false;
  }
  copyFileSync(src, dest);
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
  return true;
}

const triple = rustcHostTriple();
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const dest = resolve(binariesDir, `combai-mcp-${triple}${exeSuffix}`);

mkdirSync(binariesDir, { recursive: true });
if (!existsSync(dest)) {
  writeFileSync(dest, "");
}

console.log(`[combai-mcp] building for ${triple}`);
run("cargo", ["build", "--release", "--bin", "combai-mcp"], {
  cwd: crateDir,
});

const built = resolve(crateDir, "target/release", `combai-mcp${exeSuffix}`);
if (!existsSync(built)) {
  throw new Error(`expected build artifact missing: ${built}`);
}

const copied = copyIfChanged(built, dest);
console.log(
  copied ? `[combai-mcp] -> ${dest}` : `[combai-mcp] unchanged ${dest}`,
);

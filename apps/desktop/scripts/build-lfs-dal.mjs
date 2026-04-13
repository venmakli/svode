#!/usr/bin/env node
// Build the lfs-dal sidecar and place it where Tauri's `externalBin` expects:
// `apps/desktop/src-tauri/binaries/lfs-dal-<target-triple>[.exe]`.
//
// Tauri matches the suffix against the host's rustc target triple at bundle
// time, so we ask rustc itself for the triple instead of guessing per-OS.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(__dirname, "../../../crates/lfs-dal");
const binariesDir = resolve(__dirname, "../src-tauri/binaries");

function rustcHostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error(`could not parse host triple from rustc -vV:\n${out}`);
  return m[1].trim();
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
  }
}

const triple = rustcHostTriple();
const exeSuffix = process.platform === "win32" ? ".exe" : "";

console.log(`[lfs-dal] building for ${triple}`);
run("cargo", ["build", "--release"], { cwd: crateDir });

const built = resolve(crateDir, "target/release", `lfs-dal${exeSuffix}`);
if (!existsSync(built)) {
  throw new Error(`expected build artifact missing: ${built}`);
}

mkdirSync(binariesDir, { recursive: true });
const dest = resolve(binariesDir, `lfs-dal-${triple}${exeSuffix}`);
copyFileSync(built, dest);
console.log(`[lfs-dal] -> ${dest}`);

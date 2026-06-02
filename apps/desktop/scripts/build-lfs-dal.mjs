#!/usr/bin/env node
// Build the lfs-dal sidecar and place it where Tauri's `externalBin` expects:
// `apps/desktop/src-tauri/binaries/lfs-dal-<target-triple>[.exe]`.
//
// Tauri matches the suffix against the host's rustc target triple at bundle
// time, so we ask rustc itself for the triple instead of guessing per-OS.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(__dirname, "../../../crates/lfs-dal");
const binariesDir = resolve(__dirname, "../src-tauri/binaries");

function rustcHostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m)
    throw new Error(`could not parse host triple from rustc -vV:\n${out}`);
  return m[1].trim();
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
  }
}

function exeSuffixForTarget(triple) {
  return triple.includes("windows") ? ".exe" : "";
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

function builtBinaryPath(triple) {
  const exeSuffix = exeSuffixForTarget(triple);
  return resolve(crateDir, "target", triple, "release", `lfs-dal${exeSuffix}`);
}

function buildTarget(triple) {
  console.log(`[lfs-dal] building for ${triple}`);
  run("cargo", ["build", "--release", "--target", triple], { cwd: crateDir });

  const built = builtBinaryPath(triple);
  if (!existsSync(built)) {
    throw new Error(`expected build artifact missing: ${built}`);
  }
  return built;
}

function lipoUniversal(inputs, dest) {
  if (process.platform !== "darwin") {
    throw new Error("universal-apple-darwin sidecars can only be built on macOS");
  }
  rmSync(dest, { force: true });
  run("lipo", ["-create", "-output", dest, ...inputs]);
  chmodSync(dest, 0o755);
}

const requestedTriple = process.env.TAURI_ENV_TARGET_TRIPLE || rustcHostTriple();
const targets =
  requestedTriple === "universal-apple-darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : [requestedTriple];

mkdirSync(binariesDir, { recursive: true });
const built = targets.map(buildTarget);
const dest = resolve(
  binariesDir,
  `lfs-dal-${requestedTriple}${exeSuffixForTarget(requestedTriple)}`,
);

if (requestedTriple === "universal-apple-darwin") {
  lipoUniversal(built, dest);
  console.log(`[lfs-dal] -> ${dest}`);
} else {
  const copied = copyIfChanged(built[0], dest);
  console.log(copied ? `[lfs-dal] -> ${dest}` : `[lfs-dal] unchanged ${dest}`);
}

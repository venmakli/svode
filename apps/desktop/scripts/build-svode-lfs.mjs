#!/usr/bin/env node
// Build the svode-lfs sidecar and place it where Tauri's `externalBin` expects:
// `apps/desktop/src-tauri/binaries/svode-lfs-<target-triple>[.exe]`.
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
import { cargoTargetDir } from "./cargo-target.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(__dirname, "../../../crates/svode-lfs");
const binariesDir = resolve(__dirname, "../src-tauri/binaries");
const targetDir = cargoTargetDir();

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
  return resolve(targetDir, triple, "lfs-release", `svode-lfs${exeSuffix}`);
}

function sidecarPath(triple) {
  return resolve(binariesDir, `svode-lfs-${triple}${exeSuffixForTarget(triple)}`);
}

function buildTarget(triple) {
  console.log(`[svode-lfs] building for ${triple}`);
  run(
    "cargo",
    ["build", "-p", "svode-lfs", "--profile", "lfs-release", "--target", triple],
    {
      cwd: crateDir,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    },
  );

  const built = builtBinaryPath(triple);
  if (!existsSync(built)) {
    throw new Error(`expected build artifact missing: ${built}`);
  }
  return built;
}

function lipoUniversal(inputs, dest) {
  if (process.platform !== "darwin") {
    throw new Error(
      "universal-apple-darwin sidecars can only be built on macOS",
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  run("lipo", ["-create", "-output", dest, ...inputs]);
  chmodSync(dest, 0o755);
}

function tauriTargetBinaryPath(triple) {
  return resolve(
    targetDir,
    triple,
    "lfs-release",
    `svode-lfs${exeSuffixForTarget(triple)}`,
  );
}

const requestedTriple =
  process.env.TAURI_ENV_TARGET_TRIPLE || rustcHostTriple();
const targets =
  requestedTriple === "universal-apple-darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : [requestedTriple];

mkdirSync(binariesDir, { recursive: true });
const built = targets.map(buildTarget);

if (requestedTriple === "universal-apple-darwin") {
  targets.forEach((target, index) => {
    const copied = copyIfChanged(built[index], sidecarPath(target));
    console.log(
      copied
        ? `[svode-lfs] -> ${sidecarPath(target)}`
        : `[svode-lfs] unchanged ${sidecarPath(target)}`,
    );
  });

  const universalDest = sidecarPath(requestedTriple);
  lipoUniversal(built, universalDest);
  console.log(`[svode-lfs] -> ${universalDest}`);

  const tauriDest = tauriTargetBinaryPath(requestedTriple);
  lipoUniversal(built, tauriDest);
  console.log(`[svode-lfs] -> ${tauriDest}`);
} else {
  const dest = sidecarPath(requestedTriple);
  const copied = copyIfChanged(built[0], dest);
  console.log(copied ? `[svode-lfs] -> ${dest}` : `[svode-lfs] unchanged ${dest}`);
}

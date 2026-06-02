#!/usr/bin/env node
// Build the svode-mcp sidecar and place it where Tauri's `externalBin`
// expects: `apps/desktop/src-tauri/binaries/svode-mcp-<target-triple>[.exe]`.

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
  return resolve(crateDir, "target", triple, "release", `svode-mcp${exeSuffix}`);
}

function buildTarget(triple) {
  console.log(`[svode-mcp] building for ${triple}`);
  run("cargo", ["build", "--release", "--bin", "svode-mcp", "--target", triple], {
    cwd: crateDir,
  });

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
  `svode-mcp-${requestedTriple}${exeSuffixForTarget(requestedTriple)}`,
);

if (requestedTriple === "universal-apple-darwin") {
  lipoUniversal(built, dest);
  console.log(`[svode-mcp] -> ${dest}`);
} else {
  const copied = copyIfChanged(built[0], dest);
  console.log(
    copied ? `[svode-mcp] -> ${dest}` : `[svode-mcp] unchanged ${dest}`,
  );
}

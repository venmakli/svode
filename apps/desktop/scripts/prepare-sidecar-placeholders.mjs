#!/usr/bin/env node
// Create lightweight externalBin placeholders for `cargo check`.
//
// Tauri's build script validates configured sidecar paths even when we are not
// building an installer. The real sidecars are still built by `build:sidecars`
// in Tauri dev/build flows; these placeholders only satisfy check-time path
// validation on clean checkouts.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binariesDir = resolve(__dirname, "../src-tauri/binaries");

function rustcHostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error(`could not parse host triple from rustc -vV:\n${output}`);
  }
  return match[1].trim();
}

function exeSuffixForTarget(triple) {
  return triple.includes("windows") ? ".exe" : "";
}

function placeholderContent(triple) {
  return triple.includes("windows")
    ? "@echo off\r\nexit /b 1\r\n"
    : "#!/bin/sh\nexit 1\n";
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || rustcHostTriple();
const suffix = exeSuffixForTarget(triple);
const sidecars = ["lfs-dal", "svode-mcp"];

mkdirSync(binariesDir, { recursive: true });

for (const sidecar of sidecars) {
  const dest = resolve(binariesDir, `${sidecar}-${triple}${suffix}`);
  if (existsSync(dest)) {
    console.log(`[sidecar-placeholder] exists ${dest}`);
    continue;
  }

  writeFileSync(dest, placeholderContent(triple));
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
  console.log(`[sidecar-placeholder] created ${dest}`);
}

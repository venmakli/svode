#!/usr/bin/env node
// Build the svode-speech sidecar into `src-tauri/binaries/svode-speech-<triple>`
// and stage the engine's shared runtime into `src-tauri/speech-libs/`.
//
// macOS links the engine statically, so there is nothing to stage. On Windows
// and Linux the engine is a shared library plus loadable ggml backend
// modules; the installer puts them next to the sidecar (Windows) or into the
// app-private `/usr/lib/Svode/speech` on its rpath (Linux packages).

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "./cargo-target.mjs";
import { buildSidecar } from "./sidecar.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stagingDir = resolve(__dirname, "../src-tauri/speech-libs");
const profile = "release";

buildSidecar({ pkg: "svode-speech", bin: "svode-speech", profile });

rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

const triple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host:\s*(.+)$/m)[1].trim();
if (triple.includes("apple-darwin")) {
  process.exit(0);
}

// The build is already fresh; this pass only reads where the engine's
// runtime landed, which the crate's build script records in its OUT_DIR.
const messages = execFileSync(
  "cargo",
  [
    "build",
    "-p",
    "svode-speech",
    "--profile",
    profile,
    "--bin",
    "svode-speech",
    "--target",
    triple,
    "--message-format=json",
  ],
  {
    cwd: resolve(__dirname, "../../../crates/svode-speech"),
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir() },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const script = messages.find(
  (message) =>
    message.reason === "build-script-executed" &&
    /svode-speech[#@]/.test(message.package_id),
);
const manifest = script && resolve(script.out_dir, "engine-runtime.json");
if (!manifest || !existsSync(manifest)) {
  throw new Error(`[svode-speech] no engine runtime recorded for ${triple}`);
}
const { runtimeDir, moduleDir } = JSON.parse(readFileSync(manifest, "utf8"));

// One file per library under its runtime name: Windows DLLs as they are; on
// Linux the shortest versioned name (the SONAME) of a linked library, or the
// bare name of a dlopen'd backend module. Symlinks are copied as files.
const libraries = new Map();
for (const dir of new Set([runtimeDir, moduleDir].filter(Boolean))) {
  for (const name of readdirSync(dir)) {
    const so = name.match(/^(.*\.so)((?:\.\d+)*)$/);
    if (!name.endsWith(".dll") && !so) continue;
    const stem = so ? so[1] : name;
    const depth = so && so[2] ? so[2].split(".").length - 1 : 0;
    const rank = depth === 0 ? Number.MAX_SAFE_INTEGER : depth;
    const current = libraries.get(stem);
    if (!current || rank < current.rank) {
      libraries.set(stem, { rank, name, path: resolve(dir, name) });
    }
  }
}
if (libraries.size === 0) {
  throw new Error(`[svode-speech] no engine libraries under ${runtimeDir}`);
}
for (const { name, path } of libraries.values()) {
  copyFileSync(path, resolve(stagingDir, name));
}
console.log(`[svode-speech] staged ${libraries.size} engine libraries -> ${stagingDir}`);

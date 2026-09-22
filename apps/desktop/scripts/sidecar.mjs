// Build one Rust binary as a Tauri sidecar and place it where `externalBin`
// expects: `apps/desktop/src-tauri/binaries/<bin>-<target-triple>[.exe]`.
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
const binariesDir = resolve(__dirname, "../src-tauri/binaries");

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

/**
 * Builds binary `bin` of cargo package `pkg` with cargo profile `profile`
 * for the Tauri target triple and copies it into `src-tauri/binaries`.
 */
export function buildSidecar({ pkg, bin, profile }) {
  const crateDir = resolve(__dirname, "../../../crates", pkg);
  const targetDir = cargoTargetDir();
  const builtBinaryPath = (triple) =>
    resolve(targetDir, triple, profile, `${bin}${exeSuffixForTarget(triple)}`);
  const sidecarPath = (triple) =>
    resolve(binariesDir, `${bin}-${triple}${exeSuffixForTarget(triple)}`);

  function buildTarget(triple) {
    console.log(`[${bin}] building for ${triple}`);
    run(
      "cargo",
      [
        "build",
        "-p",
        pkg,
        "--profile",
        profile,
        "--bin",
        bin,
        "--target",
        triple,
      ],
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

  const requestedTriple =
    process.env.TAURI_ENV_TARGET_TRIPLE || rustcHostTriple();
  const targets =
    requestedTriple === "universal-apple-darwin"
      ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
      : [requestedTriple];

  mkdirSync(binariesDir, { recursive: true });

  const built = targets.map(buildTarget);
  const dest = sidecarPath(requestedTriple);

  if (requestedTriple === "universal-apple-darwin") {
    targets.forEach((target, index) => {
      const copied = copyIfChanged(built[index], sidecarPath(target));
      console.log(
        copied
          ? `[${bin}] -> ${sidecarPath(target)}`
          : `[${bin}] unchanged ${sidecarPath(target)}`,
      );
    });

    lipoUniversal(built, dest);
    console.log(`[${bin}] -> ${dest}`);

    const tauriDest = builtBinaryPath(requestedTriple);
    lipoUniversal(built, tauriDest);
    console.log(`[${bin}] -> ${tauriDest}`);
  } else {
    const copied = copyIfChanged(built[0], dest);
    console.log(copied ? `[${bin}] -> ${dest}` : `[${bin}] unchanged ${dest}`);
  }
}

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tauriDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src-tauri",
);

export function cargoTargetDir() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      cwd: tauriDir,
      encoding: "utf8",
    }),
  );
  return metadata.target_directory;
}

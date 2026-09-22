#!/usr/bin/env node
// Fail when a host-independent package pulls in the desktop crate or Tauri.
//
// svode-core, svode-mcp and svode-lfs must build and run with the Desktop
// closed, so neither they nor anything they depend on may reach
// `svode-desktop` or any `tauri*` package.

import { execFileSync } from "node:child_process";

const packages = ["svode-core", "svode-mcp", "svode-lfs"];
const forbidden = (name) => name === "svode-desktop" || /^tauri(-|$)/.test(name);

let failed = false;
for (const pkg of packages) {
  const tree = execFileSync(
    "cargo",
    [
      "tree",
      "-p",
      pkg,
      "--edges",
      "normal,build,dev",
      "--target",
      "all",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ],
    { encoding: "utf8" },
  );
  const hits = [
    ...new Set(
      tree
        .split("\n")
        .map((line) => line.trim().split(" ")[0])
        .filter((name) => name && forbidden(name)),
    ),
  ];
  if (hits.length > 0) {
    failed = true;
    console.error(`[crate-boundaries] ${pkg} depends on ${hits.join(", ")}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log(`[crate-boundaries] ok: ${packages.join(", ")} are host-free`);

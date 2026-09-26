#!/usr/bin/env node
// Fail when a host-independent package pulls in the desktop crate or Tauri.
//
// svode-core, svode-tools, svode-mcp, svode-cli and svode-lfs must build and
// run with the Desktop closed, so neither they nor anything they depend on may
// reach `svode-desktop` or any `tauri*` package. The CLI and MCP entrypoints
// share the svode-tools surface and are independent of each other, so neither
// reaches the other and svode-tools reaches neither. svode-install ships the
// launchers that stay in ~/.svode after a runtime is gone, so it reaches no
// other Svode package. svode-connect, the connection manager that the desktop
// app, svode and svode-mcp share, reaches only svode-install.

import { execFileSync } from "node:child_process";

const packages = [
  "svode-core",
  "svode-tools",
  "svode-mcp",
  "svode-cli",
  "svode-lfs",
  "svode-install",
  "svode-connect",
];
const hostBound = (name) => name === "svode-desktop" || /^tauri(-|$)/.test(name);
const extraForbidden = {
  "svode-tools": ["svode-mcp", "svode-cli"],
  "svode-mcp": ["svode-cli"],
  "svode-cli": ["svode-mcp"],
  "svode-install": ["svode-core", "svode-tools", "svode-mcp", "svode-cli", "svode-lfs", "svode-connect"],
  "svode-connect": ["svode-core", "svode-tools", "svode-mcp", "svode-cli", "svode-lfs"],
};
const forbidden = (pkg, name) => hostBound(name) || (extraForbidden[pkg] ?? []).includes(name);

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
        .filter((name) => name && forbidden(pkg, name)),
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
console.log(
  `[crate-boundaries] ok: ${packages.join(", ")} are host-free; svode-cli and svode-mcp are independent over svode-tools; svode-install is self-contained; svode-connect reaches only svode-install`,
);

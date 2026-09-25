#!/usr/bin/env node
// Installer smoke of a standalone archive for a user without Svode Desktop
// and without Svode binaries: `scripts/install.sh` installs the archive into
// the stable location of a temporary HOME, the launchers run the installed
// runtime of the product version, the payload is a complete copy, the MCP
// launcher serves the headless catalog outside a project, a second run
// updates in place and `--uninstall` removes the stable location and the
// PATH entry.
//
// usage: node scripts/smoke-install.mjs <svode-<version>-<target>.tar.gz>

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPayload, productVersion } from "./plugin-payload.mjs";

const HEADLESS_TOOLS = 53;
if (!process.argv[2]) {
  console.error("usage: node scripts/smoke-install.mjs <svode archive .tar.gz>");
  process.exit(2);
}
const archive = resolve(process.argv[2]);
const installer = join(dirname(fileURLToPath(import.meta.url)), "install.sh");
const version = productVersion();

const temp = mkdtempSync(join(tmpdir(), "svode-install-smoke-"));
const home = join(temp, "home");
mkdirSync(home);
const discovery = join(temp, "incompatible-desktop.json");
writeFileSync(
  discovery,
  JSON.stringify({ host: "127.0.0.1", port: 1, token: "smoke", pid: 0, version: "other", bridgeProtocol: "none" }),
);
// Only system tools on PATH: no Svode binary is installed beforehand.
const env = {
  HOME: home,
  SHELL: "/bin/bash",
  PATH: "/usr/bin:/bin",
  TMPDIR: temp,
  SVODE_PRODUCT_IDENTIFIER: "app.svode.desktop.smoke",
  SVODE_MCP_DISCOVERY: discovery,
};
const stable = join(home, ".svode");
const profile = join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

function run(bin, args, cwd = home) {
  return execFileSync(bin, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  const installed = run("sh", [installer, archive]);
  check(installed.includes("it is the active runtime"), "the installer makes the standalone runtime active");
  check(
    run(join(stable, "bin/svode"), ["--version"]).trim() === `svode ${version}`,
    `the svode launcher runs svode ${version}`,
  );
  check(
    run(join(stable, "bin/svode-mcp"), ["--version"]).trim() === version,
    `the svode-mcp launcher runs svode-mcp ${version}`,
  );
  checkPayload(join(stable, "current/plugins/svode"), version);
  check(true, "the stable payload address holds the complete payload of the runtime version");
  check(!existsSync(join(stable, "config.json")), "the stable location is not a Svode project");
  check(readFileSync(profile, "utf8").includes('export PATH="$HOME/.svode/bin:$PATH"'), `${profile} puts ~/.svode/bin on PATH`);

  const outside = join(temp, "outside");
  mkdirSync(outside);
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_page", arguments: { path: "x.md" } } },
  ];
  const session = spawnSync(join(stable, "bin/svode-mcp"), [], {
    cwd: outside,
    env,
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 60000,
  });
  check(session.status === 0, `the MCP launcher session ends on EOF (${session.stderr})`);
  const responses = session.stdout.trim().split("\n").map((line) => JSON.parse(line));
  check(responses[1].result.tools.length === HEADLESS_TOOLS, `the MCP launcher serves ${HEADLESS_TOOLS} headless tools`);
  check(
    responses[2].result.structuredContent.error.code === "PROJECT_UNAVAILABLE",
    "outside a project a tool call answers PROJECT_UNAVAILABLE",
  );

  run("sh", [installer, archive]);
  check(readdirSync(join(stable, "runtimes")).length === 1, "a second run updates the runtime in place");

  const removed = run("sh", [installer, "--uninstall"]);
  check(removed.includes("Removed the standalone Svode runtime"), "--uninstall removes the standalone runtime");
  check(!existsSync(stable), "the stable location is gone");
  check(!readFileSync(profile, "utf8").includes(".svode"), "the PATH entry is gone");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

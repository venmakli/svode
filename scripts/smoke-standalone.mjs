#!/usr/bin/env node
// Packaging smoke of shipped `svode` and `svode-mcp` binaries with the desktop
// app closed: the binaries in <dir> report the product version, the CLI
// creates and finds a Page in a fresh Project, and `svode-mcp --project`
// serves the headless catalog (53 tools, no run_routine) over one stdio
// session that ends on EOF.
//
// usage: node scripts/smoke-standalone.mjs <dir with svode and svode-mcp>
// Run it on a build directory, a desktop app bundle (Contents/MacOS) or an
// installed location. Needs git.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADLESS_TOOLS = 53;
const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node scripts/smoke-standalone.mjs <dir with svode and svode-mcp>");
  process.exit(2);
}
const svode = join(dir, "svode");
const svodeMcp = join(dir, "svode-mcp");
const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(app, "apps/desktop/package.json"), "utf8")).version;

const temp = mkdtempSync(join(tmpdir(), "svode-smoke-"));
const env = {
  ...process.env,
  // Device-local settings apart from the user's own; no desktop bridge.
  SVODE_PRODUCT_IDENTIFIER: "app.svode.desktop.smoke",
  SVODE_MCP_DISCOVERY: join(temp, "no-desktop.json"),
  GIT_TERMINAL_PROMPT: "0",
};
delete env.SVODE_MCP_ROUTINE_CALLER_TOKEN;

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

function run(bin, args, cwd = temp) {
  return execFileSync(bin, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function project() {
  const root = join(temp, "project");
  write(join(root, ".svode/config.json"), JSON.stringify({ name: "Smoke" }));
  write(join(root, "README.md"), "---\ntitle: Smoke\n---\nOwner\n");
  write(join(root, "notes.md"), "---\ntitle: Notes\n---\nNotes body\n");
  write(
    join(root, "tasks/schema.yaml"),
    "columns:\n  - name: Status\n    type: text\nviews:\n  - type: table\n    name: Table\n",
  );
  write(join(root, "tasks/README.md"), "---\ntitle: Tasks\n---\n");
  write(join(root, "tasks/alpha.md"), "---\ntitle: Alpha\nStatus: Todo\n---\nAlpha body\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "smoke@example.com"],
    ["config", "user.name", "Smoke"],
    ["add", "-A"],
    ["commit", "-q", "-m", "smoke"],
  ]) {
    execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  }
  return root;
}

function cli(root, args) {
  return JSON.parse(run(svode, ["--project", root, "--json", ...args]));
}

function mcpSession(root, requests) {
  return new Promise((resolveSession, reject) => {
    const child = spawn(svodeMcp, ["--project", root], { cwd: temp, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("svode-mcp did not exit after EOF"));
    }, 20_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`svode-mcp exited ${code}: ${stderr}`));
      const responses = new Map();
      for (const line of stdout.split("\n").filter(Boolean)) {
        const response = JSON.parse(line);
        responses.set(response.id, response);
      }
      resolveSession(responses);
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

try {
  check(run(svode, ["--version"]).trim() === `svode ${version}`, `svode --version is ${version}`);
  check(run(svodeMcp, ["--version"]).trim() === version, `svode-mcp --version is ${version}`);

  const root = project();
  const created = cli(root, ["page", "create", "--parent", "", "--title", "Smoke page", "--body", "packaging smoke body"]);
  check(created.ok && created.path === "Smoke page.md", "svode page create writes a Page without the desktop app");
  const found = cli(root, ["search", "packaging smoke body"]);
  check(
    found.index?.status === "fresh" && found.items.some((item) => item.path === "Smoke page.md"),
    "svode search builds the index and finds it",
  );
  const doctor = cli(root, ["doctor"]);
  check(doctor.doctor.runtime.servedTools.length === HEADLESS_TOOLS, `svode doctor serves ${HEADLESS_TOOLS} tools`);

  const responses = await mcpSession(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_pages", arguments: { query: "packaging smoke body" } },
    },
  ]);
  check(responses.get(1)?.result?.serverInfo?.version === version, `svode-mcp serverInfo.version is ${version}`);
  const tools = responses.get(2)?.result?.tools?.map((tool) => tool.name) ?? [];
  check(
    tools.length === HEADLESS_TOOLS && !tools.includes("run_routine"),
    `svode-mcp --project lists ${HEADLESS_TOOLS} tools without run_routine`,
  );
  const search = responses.get(3)?.result;
  check(
    search?.isError !== true && search?.structuredContent?.items?.some((item) => item.path === "Smoke page.md"),
    "svode-mcp --project answers search_pages and exits on EOF",
  );
  const head = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  check(head === "1", "no commit was made");
} catch (error) {
  console.error(`not ok - ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}

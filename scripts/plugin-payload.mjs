#!/usr/bin/env node
// The Svode plugin payload: the portable Agent Plugins core from
// `plugins/svode` (plugin.json, mcp.json, skills/, bin/) stamped with the
// product version, plus the Claude Code variant generated from it
// (.claude-plugin/plugin.json and .mcp.json), since Claude Code does not read
// the portable manifests. The desktop bundle and the standalone archive ship
// the same payload as their runtime.
//
// usage:
//   node scripts/plugin-payload.mjs build <out dir>
//   node scripts/plugin-payload.mjs check <payload dir> [<svode binary>]
// `check` verifies the layout and that both manifests carry the product
// version, or the version `<svode binary> --version` reports.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(app, "plugins/svode");
const LAUNCHERS = ["svode", "svode-mcp"];

export function productVersion() {
  return JSON.parse(
    readFileSync(join(app, "apps/desktop/package.json"), "utf8"),
  ).version;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes the payload of the product version into `out`, replacing it. */
export function buildPayload(out) {
  const version = productVersion();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const entry of ["mcp.json", "skills", "bin"]) {
    cpSync(join(source, entry), join(out, entry), { recursive: true });
  }
  for (const launcher of LAUNCHERS) {
    chmodSync(join(out, "bin", launcher), 0o755);
  }

  const { $schema, name, description, author, repository, keywords } = readJson(
    join(source, "plugin.json"),
  );
  writeJson(join(out, "plugin.json"), {
    $schema,
    name,
    version,
    description,
    author,
    repository,
    keywords,
  });

  // Claude Code: the same skills and bin/, the manifest in .claude-plugin/
  // and the MCP server started in the session directory through bin/.
  writeJson(join(out, ".claude-plugin/plugin.json"), {
    name,
    version,
    description,
    author,
    repository,
    keywords,
  });
  const servers = readJson(join(source, "mcp.json")).mcpServers;
  writeJson(join(out, ".mcp.json"), {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([server, { command, args }]) => [
        server,
        {
          command: command.replace(/^\.\//, "${CLAUDE_PLUGIN_ROOT}/"),
          ...(args ? { args } : {}),
        },
      ]),
    ),
  });
  return version;
}

/** Throws unless `dir` is a complete payload of `version`. */
export function checkPayload(dir, version = productVersion()) {
  const portable = readJson(join(dir, "plugin.json"));
  const claude = readJson(join(dir, ".claude-plugin/plugin.json"));
  for (const [file, manifest] of [
    ["plugin.json", portable],
    [".claude-plugin/plugin.json", claude],
  ]) {
    if (manifest.name !== "svode" || manifest.version !== version) {
      throw new Error(
        `${file}: expected svode ${version}, found ${manifest.name} ${manifest.version}`,
      );
    }
  }
  if (
    !readJson(join(dir, ".mcp.json")).mcpServers?.svode ||
    !readJson(join(dir, "mcp.json")).mcpServers?.svode
  ) {
    throw new Error("the MCP server svode is missing");
  }
  if (!existsSync(join(dir, "skills/svode/SKILL.md"))) {
    throw new Error("skills/svode/SKILL.md is missing");
  }
  for (const launcher of LAUNCHERS) {
    if ((statSync(join(dir, "bin", launcher)).mode & 0o111) === 0) {
      throw new Error(`bin/${launcher} is not executable`);
    }
  }
}

function runtimeVersion(svode) {
  const output = execFileSync(svode, ["--version"], {
    encoding: "utf8",
  }).trim();
  const version = output.split(/\s+/).pop();
  if (!version)
    throw new Error(`unexpected ${svode} --version output: ${output}`);
  return version;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, dir, svode] = process.argv.slice(2);
  if (command === "build" && dir) {
    const version = buildPayload(resolve(dir));
    console.log(`[plugin-payload] svode ${version} -> ${resolve(dir)}`);
  } else if (command === "check" && dir) {
    const version = svode ? runtimeVersion(svode) : productVersion();
    checkPayload(resolve(dir), version);
    console.log(
      `[plugin-payload] ok - ${resolve(dir)} is the svode ${version} payload`,
    );
  } else {
    console.error(
      "usage: plugin-payload.mjs build <out dir> | check <payload dir> [<svode binary>]",
    );
    process.exit(2);
  }
}

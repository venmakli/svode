import { expect, test } from "bun:test";

import {
  buildAgentContextDiagnosticReadModel,
  countAgentContextDiagnostics,
} from "./diagnostics";

const missingManifest =
  "Skill directory /workspace/.agents/skills/missing has no SKILL.md";
const outsideBoundary =
  "Instruction alias /workspace/AGENTS.md resolves outside allowed root /workspace";

test("preserves raw messages and deduplicates only the exact diagnostic identity", () => {
  const duplicate = {
    adapterId: "codex" as const,
    code: "skill_manifest_missing",
    message: missingManifest,
    path: "/workspace/.agents/skills/missing/SKILL.md",
    severity: "warning" as const,
  };
  const groups = buildAgentContextDiagnosticReadModel({
    diagnostics: [
      duplicate,
      { ...duplicate },
      { ...duplicate, path: "/workspace/.agents/skills/other/SKILL.md" },
      {
        adapterId: "codex",
        code: "instruction_outside_boundary",
        message: outsideBoundary,
        path: "/workspace/AGENTS.md",
        severity: "warning",
      },
    ],
    refreshError: null,
  });

  expect(countAgentContextDiagnostics(groups)).toBe(3);
  expect(
    groups.flatMap((group) => group.diagnostics.map(({ message }) => message)),
  ).toEqual([outsideBoundary, missingManifest, missingManifest]);
});

test("groups from stable metadata, keeps unknown codes, and appends the raw refresh error", () => {
  const groups = buildAgentContextDiagnosticReadModel({
    diagnostics: [
      {
        adapterId: null,
        code: "future_scanner_code",
        message: "Unknown diagnostic remains visible",
        path: "/workspace/future",
        severity: "error",
      },
      {
        adapterId: "claude-code",
        code: "claude_import_cycle",
        message: "Import cycle at /workspace/CLAUDE.md",
        path: "/workspace/CLAUDE.md",
        severity: "warning",
      },
    ],
    refreshError: "source changed during scan",
  });

  expect(groups.map(({ id }) => id)).toEqual([
    "instructions",
    "runtime",
    "other",
  ]);
  expect(groups[1]?.diagnostics[0]?.code).toBe("background_refresh_failed");
  expect(groups[1]?.diagnostics[0]?.message).toBe("source changed during scan");
  expect(groups[1]?.diagnostics[0]?.origin).toBe("runtime");
  expect(groups[2]?.diagnostics[0]?.message).toBe(
    "Unknown diagnostic remains visible",
  );
});

test("plugin manifests and the plugin registries of the agents form their own group", () => {
  const groups = buildAgentContextDiagnosticReadModel({
    diagnostics: [
      {
        adapterId: "claude-code",
        code: "claude_plugin_registry_parse",
        message: "Could not parse the Claude Code plugin registry",
        path: "/home/user/.claude/plugins/installed_plugins.json",
        severity: "warning",
      },
      {
        adapterId: "codex",
        code: "plugin_manifest_parse",
        message: "Could not parse plugin manifest",
        path: "/home/user/.codex/plugins/cache/m/p/1/plugin.json",
        severity: "warning",
      },
      {
        adapterId: "claude-code",
        code: "claude_settings_parse",
        message: "Could not parse Claude Code settings",
        path: "/home/user/.claude/settings.json",
        severity: "warning",
      },
    ],
    refreshError: null,
  });

  expect(
    groups.map((group) => [
      group.id,
      group.diagnostics.map(({ code }) => code),
    ]),
  ).toEqual([
    ["instructions", ["claude_settings_parse"]],
    ["plugins", ["claude_plugin_registry_parse", "plugin_manifest_parse"]],
  ]);
});

test("MCP config diagnostics form their own group after plugins", () => {
  const groups = buildAgentContextDiagnosticReadModel({
    diagnostics: [
      {
        adapterId: "claude-code",
        code: "mcp_config_parse",
        message: "Could not parse the MCP servers of /workspace/.mcp.json",
        path: "/workspace/.mcp.json",
        severity: "warning",
      },
      {
        adapterId: "claude-code",
        code: "plugin_manifest_parse",
        message: "Could not parse plugin manifest /kit/plugin.json",
        path: "/kit/plugin.json",
        severity: "warning",
      },
    ],
    refreshError: null,
  });

  expect(groups.map((group) => group.id)).toEqual(["plugins", "mcp_servers"]);
});

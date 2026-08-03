import { expect, test } from "bun:test";

import { toAgentContextInstructionsSnapshot } from "./agent-context-api";

const unavailable = {
  availability: "unavailable" as const,
  reason: "not available in Agent Context phase 5.1",
};

const dto: Parameters<typeof toAgentContextInstructionsSnapshot>[0] = {
  adapters: [
    {
      capabilities: {
        instructions: {
          availability: "available",
          policy: "claude_memory",
        },
        skills: {
          availability: "available",
          personalRoots: [
            {
              kind: "standard_personal",
              path: "/home/user/.claude/skills",
            },
          ],
          policy: "claude_personal_shadows_project",
          projectRelativeRoot: ".claude/skills",
        },
        launch: unavailable,
        modelSelection: unavailable,
        permissionModes: unavailable,
      },
      displayName: "Claude Code",
      executable: {
        diagnostic: null,
        executable: "claude",
        path: "/usr/local/bin/claude",
        version: "2.1.179",
      },
      id: "claude-code",
      nativeDefault: {
        additionalRoots: false,
        cwd: "target_space_root",
        hiddenLauncherConfig: false,
        projectedContext: false,
      },
      personalRoot: "/home/user/.claude",
    },
  ],
  diagnostics: [
    {
      adapterId: "claude-code",
      code: "external_import",
      message: "Import requires client approval",
      path: "/workspace/CLAUDE.md",
      severity: "warning",
    },
    {
      adapterId: null,
      code: "skill_manifest_warning",
      message: "Skill name does not match its canonical directory name",
      path: "/workspace/shared/review/SKILL.md",
      severity: "warning",
    },
    {
      adapterId: "codex",
      code: "skill_manifest_missing",
      message:
        "Skill directory /home/user/.codex/skills/legacy has no SKILL.md",
      path: "/home/user/.codex/skills/legacy/SKILL.md",
      severity: "warning",
    },
  ],
  generation: 3,
  instructions: [
    {
      adapterId: "claude-code",
      availability: "compatibility_unknown",
      canonicalPath: "/workspace/shared/CLAUDE.md",
      discovery: {
        directoryDepth: 0,
        effective: false,
        policy: "claude_hierarchy",
        precedence: 2,
      },
      id: "claude:/workspace/CLAUDE.md",
      name: "CLAUDE.md",
      owner: { kind: "target_space", root: "/workspace" },
      path: "/workspace/CLAUDE.md",
      preview: {
        bytesRead: 20,
        markdown: "# Linked instructions",
        totalBytes: 20,
        truncated: false,
      },
      reason: "Filesystem alias support is not proven for this version",
      references: [
        {
          availability: "compatibility_unknown",
          canonicalPath: null,
          depth: 1,
          path: "../personal.md",
          preview: null,
          reason: "External import requires client approval",
        },
      ],
      sourceKind: "project",
    },
  ],
  observedPersonalPaths: ["/home/user/.claude/CLAUDE.md"],
  observedProjectPaths: ["/workspace/CLAUDE.md"],
  projectRoot: "/workspace",
  repositoryRoot: "/workspace",
  skills: [
    {
      aliases: [
        {
          adapterId: "codex",
          availability: "available",
          discoveryKind: "codex_project",
          linkKind: "direct",
          owner: { kind: "target_space", root: "/workspace" },
          path: "/workspace/.agents/skills/review",
          reason: null,
          root: "/workspace/.agents/skills",
          scope: "project",
        },
        {
          adapterId: "claude-code",
          availability: "compatibility_unknown",
          discoveryKind: "claude_project",
          linkKind: "symbolic_link",
          owner: { kind: "target_space", root: "/workspace" },
          path: "/workspace/.claude/skills/review",
          reason: "Claude Code alias support is not proven",
          root: "/workspace/.claude/skills",
          scope: "project",
        },
      ],
      canonicalPath: "/workspace/shared/review",
      compatibility: null,
      description: "Review changes against project conventions",
      id: "skill:/workspace/shared/review",
      license: "MIT",
      metadata: { author: "Svode" },
      name: "review",
      path: "/workspace/shared/review/SKILL.md",
      preview: {
        bytesRead: 24,
        markdown: "# Review\n\nRead the diff.",
        totalBytes: 24,
        truncated: false,
      },
      validation: "warning",
      warnings: ["Skill name does not match its canonical directory name"],
    },
  ],
  targetRoot: "/workspace",
};

test("transport provenance is normalized without recomputing precedence", () => {
  const snapshot = toAgentContextInstructionsSnapshot(dto);
  const row = snapshot.rows[0];

  expect(snapshot.targetPath).toBe("/workspace");
  expect(snapshot.generation).toBe(3);
  expect(snapshot.hasPersonalSources).toBe(true);
  expect(row?.availability).toBe("compatibility_unknown");
  expect(row?.precedence).toBe(2);
  expect(row?.linkTargetPath).toBe("/workspace/shared/CLAUDE.md");
  expect(row?.references[0]?.status).toBe("requires_client_approval");
  expect(row?.diagnostics).toEqual(["Import requires client approval"]);
  expect(snapshot.adapters[0]?.id).toBe("claude-code");
  expect(snapshot.adapters[0]?.capabilities.launch).toBe(false);
  expect(snapshot.adapters[0]?.capabilities.skillsDiscovery).toBe(true);
  expect(snapshot.skills[0]?.clients).toEqual(["codex", "claude-code"]);
  expect(snapshot.skills[0]?.scopes).toEqual(["project"]);
  expect(snapshot.skills[0]?.aliases[1]?.linkKind).toBe("symbolic_link");
  expect(snapshot.skills[0]?.diagnostics).toEqual([
    "Skill name does not match its canonical directory name",
  ]);
  expect(snapshot.instructionDiagnostics).toEqual([
    "Import requires client approval",
  ]);
  expect(snapshot.skillDiagnostics).toEqual([
    "Skill directory /home/user/.codex/skills/legacy has no SKILL.md",
  ]);
});

import { expect, test } from "bun:test";

import { toAgentContextInstructionsSnapshot } from "./agent-context-api";

const dto: Parameters<typeof toAgentContextInstructionsSnapshot>[0] = {
  adapters: [
    {
      capabilities: {
        instructions: {
          policy: "claude_memory",
        },
        skills: {
          personalRoots: [
            {
              kind: "standard_personal",
              path: "/home/user/.claude/skills",
            },
          ],
          policy: "claude_personal_shadows_project",
          projectRelativeRoot: ".claude/skills",
        },
      },
      displayName: "Claude Code",
      id: "claude-code",
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
      message: "Skill directory has no SKILL.md",
      path: "/workspace/.agents/skills/legacy/SKILL.md",
      severity: "warning",
    },
  ],
  generation: 3,
  instructions: [
    {
      adapterId: "claude-code",
      canonicalPath: "/workspace/shared/CLAUDE.md",
      discovery: {
        directoryDepth: 0,
        policy: "claude_hierarchy",
        precedence: 2,
      },
      health: "normal",
      healthReasons: [],
      id: "claude:/workspace/CLAUDE.md",
      linkKind: "symbolic_link",
      name: "CLAUDE.md",
      owner: { kind: "target_space", root: "/workspace" },
      path: "/workspace/CLAUDE.md",
      preview: {
        bytesRead: 20,
        markdown: "# Linked instructions",
        totalBytes: 20,
        truncated: false,
      },
      resolution: "included",
      references: [
        {
          canonicalPath: null,
          depth: 1,
          path: "../personal.md",
          preview: null,
          status: "requires_client_approval",
        },
      ],
      sourceKind: "project",
      support: "client_native",
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
          discoveryKind: "codex_project",
          linkKind: "direct",
          owner: { kind: "target_space", root: "/workspace" },
          path: "/workspace/.agents/skills/review",
          resolution: "selected",
          root: "/workspace/.agents/skills",
          scope: "project",
          support: "client_native",
        },
        {
          adapterId: "claude-code",
          discoveryKind: "claude_project",
          linkKind: "symbolic_link",
          owner: { kind: "target_space", root: "/workspace" },
          path: "/workspace/.claude/skills/review",
          resolution: "included",
          root: "/workspace/.claude/skills",
          scope: "project",
          support: "client_native",
        },
      ],
      canonicalPath: "/workspace/shared/review",
      compatibility: null,
      description: "Review changes against project conventions",
      health: "degraded",
      healthReasons: ["Skill name does not match its canonical directory name"],
      id: "skill:/workspace/shared/review",
      license: "MIT",
      metadata: { author: "Svode" },
      name: "review",
      owner: { kind: "target_space", root: "/workspace" },
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

test("transport keeps source semantics independent without message parsing", () => {
  const snapshot = toAgentContextInstructionsSnapshot(dto);
  const row = snapshot.rows[0];

  expect(snapshot.targetPath).toBe("/workspace");
  expect(snapshot.generation).toBe(3);
  expect(snapshot.hasPersonalSources).toBe(true);
  expect(row?.support).toBe("client_native");
  expect(row?.resolution).toBe("included");
  expect(row?.health).toBe("normal");
  expect(row?.healthReasons).toEqual([]);
  expect(row?.location).toBe("space");
  expect(row?.linkKind).toBe("symbolic_link");
  expect(row?.precedence).toBe(2);
  expect(row?.linkTargetPath).toBe("/workspace/shared/CLAUDE.md");
  expect(row?.references[0]?.status).toBe("requires_client_approval");
  expect(snapshot.skills[0]?.ownerPath).toBe("/workspace");
  expect(snapshot.skills[0]?.aliases[0]?.sourceFamily).toBe("agents");
  expect(snapshot.skills[0]?.aliases[1]?.sourceFamily).toBe("claude");
  expect(snapshot.skills[0]?.aliases[1]?.location).toBe("space");
  expect(snapshot.skills[0]?.aliases[1]?.linkKind).toBe("symbolic_link");
  expect(snapshot.skills[0]?.health).toBe("degraded");
  expect(snapshot.skills[0]?.healthReasons).toEqual([
    "Skill name does not match its canonical directory name",
  ]);
  expect(snapshot.diagnostics).toEqual(dto.diagnostics);
  expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
  expect(Object.isFrozen(snapshot.diagnostics[0])).toBe(true);
});

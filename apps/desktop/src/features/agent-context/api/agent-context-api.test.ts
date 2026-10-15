import { expect, test } from "bun:test";

import { toAgentContextSnapshot } from "./agent-context-api";

const preview = {
  bytesRead: 7,
  markdown: "# Guide",
  totalBytes: 7,
  truncated: false,
};

const dto: Parameters<typeof toAgentContextSnapshot>[0] = {
  diagnostics: [
    {
      adapterId: "claude-code",
      code: "claude_import_external",
      message: "Import requires client approval",
      path: "/workspace/CLAUDE.md",
      severity: "warning",
    },
  ],
  enabledAgents: ["codex", "claude-code"],
  generation: 3,
  items: [
    {
      description: null,
      health: "normal",
      healthReasons: [],
      id: "instruction:/workspace/AGENTS.md",
      kind: "instruction",
      location: { kind: "target", path: "" },
      modifiedAt: "2026-10-15T08:00:00Z",
      name: "AGENTS.md",
      ownerRoot: "/workspace",
      path: "/workspace/AGENTS.md",
      preview,
      providers: ["codex", "claude-code"],
      references: [
        {
          canonicalPath: null,
          depth: 1,
          path: "~/.claude/notes.md",
          preview: null,
          status: "requires_client_approval",
        },
        {
          canonicalPath: "/workspace/docs/style.md",
          depth: 1,
          path: "/workspace/docs/style.md",
          preview: null,
          status: "included",
        },
      ],
      skill: null,
      sources: [
        {
          linkKind: "direct",
          path: "/workspace/AGENTS.md",
          readers: [{ agent: "codex", supersededBy: null }],
          target: null,
        },
        {
          linkKind: "symbolic_link",
          path: "/workspace/CLAUDE.md",
          readers: [{ agent: "claude-code", supersededBy: null }],
          target: "/workspace/AGENTS.md",
        },
      ],
      unapplied: null,
    },
    {
      description: "Review project changes.",
      health: "degraded",
      healthReasons: ["Skill name does not match its canonical directory name"],
      id: "skill:/workspace/.claude/skills/review",
      kind: "skill",
      location: { kind: "target", path: ".claude/skills" },
      modifiedAt: null,
      name: "review",
      ownerRoot: "/workspace",
      path: "/workspace/.claude/skills/review/SKILL.md",
      preview: { ...preview, truncated: true },
      providers: [],
      references: [],
      skill: {
        directory: "/workspace/.claude/skills/review",
        hasFiles: true,
        allowedTools: "Read Bash(git:*)",
        compatibility: null,
        license: "MIT",
        metadata: {
          author: { kind: "text", value: "Svode" },
          owner: {
            kind: "object",
            value: {
              channels: { kind: "list", value: ["desk", "mail"] },
              team: { kind: "text", value: "core" },
            },
          },
          tags: { kind: "list", value: ["review", "git"] },
        },
      },
      sources: [
        {
          linkKind: "direct",
          path: "/workspace/.claude/skills/review",
          readers: [
            {
              agent: "claude-code",
              supersededBy: "/home/user/.claude/skills/review",
            },
          ],
          target: null,
        },
      ],
      unapplied: {
        by: ["/home/user/.claude/skills/review"],
        kind: "superseded",
      },
    },
  ],
  observedPersonalPaths: ["/home/user/.claude/CLAUDE.md"],
  observedProjectPaths: ["/workspace/AGENTS.md"],
  projectRoot: "/workspace",
  repositoryRoot: "/workspace",
  targetRoot: "/workspace",
};

test("transport becomes one frozen set of items with their application", () => {
  const snapshot = toAgentContextSnapshot(dto);
  const [instruction, skill] = snapshot.items;

  expect(snapshot.targetPath).toBe("/workspace");
  expect(snapshot.generation).toBe(3);
  expect(snapshot.hasPersonalSources).toBe(true);
  expect(snapshot.enabledAgents).toEqual(["codex", "claude-code"]);
  expect(instruction?.kind).toBe("instruction");
  expect(instruction?.ownerPath).toBe("/workspace");
  expect(instruction?.body).toBe("# Guide");
  expect(instruction?.providers).toEqual(["codex", "claude-code"]);
  expect(instruction?.sources[1]).toEqual({
    path: "/workspace/CLAUDE.md",
    readers: [{ agent: "claude-code", supersededBy: null }],
    target: "/workspace/AGENTS.md",
  });
  expect(instruction?.references.map((reference) => reference.status)).toEqual([
    "requires_client_approval",
    "available",
  ]);
  expect(skill?.unapplied).toEqual({
    by: ["/home/user/.claude/skills/review"],
    kind: "superseded",
  });
  expect(skill?.truncated).toBe(true);
  expect(skill?.skill?.allowedTools).toBe("Read Bash(git:*)");
  expect(skill?.skill?.metadata).toEqual({
    author: { kind: "text", text: "Svode" },
    owner: {
      entries: [
        ["channels", { items: ["desk", "mail"], kind: "list" }],
        ["team", { kind: "text", text: "core" }],
      ],
      kind: "object",
    },
    tags: { items: ["review", "git"], kind: "list" },
  });
  expect(Object.isFrozen(snapshot.items)).toBe(true);
  expect(Object.isFrozen(skill?.sources[0]?.readers)).toBe(true);
  expect(Object.isFrozen(skill?.skill?.metadata)).toBe(true);
  expect(snapshot.diagnostics).toEqual(dto.diagnostics);
  expect(Object.isFrozen(snapshot.diagnostics[0])).toBe(true);
});

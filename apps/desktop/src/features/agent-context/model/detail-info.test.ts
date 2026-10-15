import { expect, test } from "bun:test";

import {
  instructionImports,
  instructionSourceLines,
  skillSourceLines,
} from "./detail-info";
import type { AgentContextInstructionRow, AgentContextSkillRow } from "./types";

const instruction: AgentContextInstructionRow = {
  adapterId: "codex",
  body: "",
  canonicalPath: "/workspace/AGENTS.md",
  discoveryPath: "/workspace/AGENTS.md",
  filename: "AGENTS.md",
  health: "normal",
  healthReasons: [],
  id: "codex:/workspace/AGENTS.md",
  linkKind: "direct",
  linkTargetPath: null,
  location: "space",
  ownerPath: "/workspace",
  precedence: 1,
  references: [],
  resolution: "selected",
  role: "codex_directory_precedence",
  support: "client_native",
  truncated: false,
};

test("a direct instruction is one source line without a target", () => {
  expect(instructionSourceLines(instruction)).toEqual([
    { linkKind: "direct", path: "/workspace/AGENTS.md", target: null },
  ]);
  expect(
    instructionSourceLines({
      ...instruction,
      discoveryPath: "/workspace/CLAUDE.md",
      linkKind: "directory_alias",
      linkTargetPath: null,
    }),
  ).toEqual([
    {
      linkKind: "directory_alias",
      path: "/workspace/CLAUDE.md",
      target: "/workspace/AGENTS.md",
    },
  ]);
});

test("instruction imports keep every distinct path and status in order", () => {
  expect(
    instructionImports({
      ...instruction,
      references: [
        { path: "/a.md", status: "available" },
        { path: "/b.md", status: "unreadable" },
        { path: "/a.md", status: "available" },
        { path: "/a.md", status: "outside_boundary" },
      ],
    }),
  ).toEqual([
    { path: "/a.md", status: "available" },
    { path: "/b.md", status: "unreadable" },
    { path: "/a.md", status: "outside_boundary" },
  ]);
});

test("a skill has one source line per discovery path", () => {
  const alias = {
    discoveryPath: "/workspace/.agents/skills/review",
    linkKind: "direct" as const,
    location: "space" as const,
    resolution: "selected" as const,
    sourceFamily: "agents" as const,
    support: "client_native" as const,
  };
  const skill = {
    aliases: [
      alias,
      { ...alias, sourceFamily: "claude" as const },
      {
        ...alias,
        discoveryPath: "/home/user/.claude/skills/review",
        linkKind: "symbolic_link" as const,
      },
    ],
    canonicalPath: "/workspace/.agents/skills/review",
  } as unknown as AgentContextSkillRow;
  expect(skillSourceLines(skill)).toEqual([
    {
      linkKind: "direct",
      path: "/workspace/.agents/skills/review",
      target: null,
    },
    {
      linkKind: "symbolic_link",
      path: "/home/user/.claude/skills/review",
      target: "/workspace/.agents/skills/review",
    },
  ]);
});

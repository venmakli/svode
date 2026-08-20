import { expect, test } from "bun:test";

import type { AgentContextInstructionRow, AgentContextSkillRow } from "./types";
import {
  instructionDetailProvenance,
  skillDetailProvenance,
} from "./detail-provenance";

const instruction: AgentContextInstructionRow = {
  adapterId: "codex",
  body: "# Project instructions",
  canonicalPath: "/workspace/AGENTS.md",
  discoveryPath: "/workspace/AGENTS.md",
  filename: "AGENTS.md",
  health: "normal",
  healthReasons: [],
  id: "instruction:/workspace/AGENTS.md",
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

const skill: AgentContextSkillRow = {
  aliases: [
    {
      discoveryPath: "/workspace/.agents/skills/review",
      linkKind: "direct",
      location: "space",
      resolution: "selected",
      sourceFamily: "agents",
      support: "client_native",
    },
  ],
  body: "# Review",
  canonicalPath: "/workspace/.agents/skills/review",
  compatibility: null,
  description: "Review changes.",
  health: "normal",
  healthReasons: [],
  id: "skill:/workspace/.agents/skills/review",
  license: null,
  manifestPath: "/workspace/.agents/skills/review/SKILL.md",
  name: "review",
  ownerPath: "/workspace",
  truncated: false,
};

test("a direct instruction projects one source path without canonical/discovery duplication", () => {
  const projection = instructionDetailProvenance(instruction);

  expect(projection.isSingleDirectSource).toBe(true);
  expect(projection.canonicalSourcePath).toBe("/workspace/AGENTS.md");
  expect(projection.sources.length).toBe(1);
  expect(projection.sources[0]?.path).toBe("/workspace/AGENTS.md");
  expect(projection.sourceLocations).toEqual(["space"]);
});

test("linked instructions keep canonical owner and exact discovery facts separate", () => {
  const projection = instructionDetailProvenance({
    ...instruction,
    canonicalPath: "/workspace/shared/AGENTS.md",
    discoveryPath: "/workspace/AGENTS.md",
    health: "degraded",
    healthReasons: ["Preview was limited", "Alias was revalidated"],
    linkKind: "symbolic_link",
    linkTargetPath: "/workspace/shared/AGENTS.md",
    references: [
      { path: "../shared.md", status: "available" },
      { path: "../shared.md", status: "available" },
    ],
    truncated: true,
  });

  expect(projection.isSingleDirectSource).toBe(false);
  expect(projection.canonicalOwnerPath).toBe("/workspace");
  expect(projection.canonicalSourcePath).toBe("/workspace/shared/AGENTS.md");
  expect(projection.sources[0]?.linkKind).toBe("symbolic_link");
  expect(projection.sources[0]?.path).toBe("/workspace/AGENTS.md");
  expect(projection.references).toEqual([
    { path: "../shared.md", status: "available" },
  ]);
  expect(projection.contentTruncated).toBe(true);
  expect(projection.diagnostics).toEqual([
    "Preview was limited",
    "Alias was revalidated",
  ]);
});

test("multi-source skills deduplicate exact aliases without merging cross-location facts", () => {
  const globalAlias = {
    ...skill.aliases[0]!,
    discoveryPath: "/home/user/.claude/skills/review",
    linkKind: "directory_alias" as const,
    location: "global" as const,
    sourceFamily: "claude" as const,
  };
  const projection = skillDetailProvenance({
    ...skill,
    aliases: [skill.aliases[0]!, globalAlias, globalAlias],
    canonicalPath: "/workspace/shared/review",
    manifestPath: "/workspace/shared/review/SKILL.md",
  });

  expect(projection.isSingleDirectSource).toBe(false);
  expect(projection.sources.length).toBe(2);
  expect(projection.sourceFamilies).toEqual(["agents", "claude"]);
  expect(projection.sourceLocations).toEqual(["space", "global"]);
  expect(projection.sources[1]?.linkKind).toBe("directory_alias");
  expect(projection.sources[1]?.location).toBe("global");
  expect(projection.sources[1]?.path).toBe("/home/user/.claude/skills/review");
  expect(projection.sources[1]?.sourceFamily).toBe("claude");
});

import { expect, test } from "bun:test";

import {
  skillSourceFamilies,
  skillSourceLocations,
  sourceFamilyFromSkillDiscovery,
  sourceLocationFromScope,
} from "./provenance";
import type { AgentContextSkillRow } from "./types";

const multiAliasSkill: AgentContextSkillRow = {
  aliases: [
    {
      discoveryPath: "/workspace/.claude/skills/review",
      linkKind: "symbolic_link",
      location: "space",
      resolution: "included",
      sourceFamily: "claude",
      support: "client_native",
    },
    {
      discoveryPath: "/home/user/.agents/skills/review",
      linkKind: "direct",
      location: "global",
      resolution: "selected",
      sourceFamily: "agents",
      support: "client_native",
    },
    {
      discoveryPath: "/workspace/.agents/skills/review",
      linkKind: "directory_alias",
      location: "space",
      resolution: "included",
      sourceFamily: "agents",
      support: "client_native",
    },
  ],
  body: "# Review",
  canonicalPath: "/workspace/shared/review",
  compatibility: null,
  description: "Review changes.",
  health: "normal",
  healthReasons: [],
  id: "skill:/workspace/shared/review",
  license: null,
  manifestPath: "/workspace/shared/review/SKILL.md",
  name: "review",
  ownerPath: "/workspace",
};

test("source facts come from declarative discovery enums, not adapter ids or paths", () => {
  expect(sourceFamilyFromSkillDiscovery("codex_project")).toBe("agents");
  expect(sourceFamilyFromSkillDiscovery("codex_standard_personal")).toBe(
    "agents",
  );
  expect(sourceFamilyFromSkillDiscovery("claude_project")).toBe("claude");
  expect(sourceFamilyFromSkillDiscovery("claude_personal")).toBe("claude");
  expect(sourceLocationFromScope("project")).toBe("space");
  expect(sourceLocationFromScope("personal")).toBe("global");
});

test("canonical skill aliases project deterministic source and location unions", () => {
  expect(skillSourceFamilies(multiAliasSkill)).toEqual(["agents", "claude"]);
  expect(skillSourceLocations(multiAliasSkill)).toEqual(["space", "global"]);
});

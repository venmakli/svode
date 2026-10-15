import { expect, test } from "bun:test";

import { sortedSkillMetadata, splitAllowedTools } from "./skill-frontmatter";

test("allowed tools split on spaces and commas but keep parenthesized arguments", () => {
  expect(splitAllowedTools("Read Bash(git:*)")).toEqual([
    "Read",
    "Bash(git:*)",
  ]);
  expect(splitAllowedTools("Read, Grep,Bash(git log:*)  Write")).toEqual([
    "Read",
    "Grep",
    "Bash(git log:*)",
    "Write",
  ]);
  expect(splitAllowedTools("  ")).toEqual([]);
});

test("skill metadata is ordered by key", () => {
  expect(sortedSkillMetadata({ zeta: "last", alpha: "first" })).toEqual([
    ["alpha", "first"],
    ["zeta", "last"],
  ]);
  expect(sortedSkillMetadata(null)).toEqual([]);
});

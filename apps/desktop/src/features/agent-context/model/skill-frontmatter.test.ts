import { expect, test } from "bun:test";

import {
  skillMetadataObjectLines,
  sortedSkillMetadata,
  splitAllowedTools,
} from "./skill-frontmatter";

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

test("a metadata object reads as key: value lines", () => {
  expect(
    skillMetadataObjectLines({
      entries: [
        ["channels", { items: ["desk", "mail"], kind: "list" }],
        ["team", { kind: "text", text: "core" }],
      ],
      kind: "object",
    }),
  ).toBe("channels: desk, mail\nteam: core");
});

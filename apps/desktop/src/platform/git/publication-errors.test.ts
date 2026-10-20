import { expect, test } from "bun:test";
import { toGitPublicationBlockDto } from "./publication-errors";

test("a publication refusal is a project reason or a list of Spaces", () => {
  expect(
    toGitPublicationBlockDto({
      kind: "git_publication_blocked",
      repository: "/project",
      reason: "target_changed",
    }),
  ).toEqual({ kind: "git_publication_blocked", reason: "target_changed" });
  const spaces = [
    { path: "compliance", class: "local_commits" },
    { path: "legal", class: "outside_branch" },
  ];
  expect(
    toGitPublicationBlockDto({
      kind: "git_publication_blocked",
      repository: "/project",
      reason: "spaces",
      spaces,
    }),
  ).toEqual({ kind: "git_publication_blocked", reason: "spaces", spaces });
});

test("the replaced single-child shape and malformed Spaces are not a refusal", () => {
  for (const error of [
    {
      kind: "git_publication_blocked",
      reason: "uninitialized_child",
      child: "develop",
    },
    { kind: "git_publication_blocked", reason: "spaces" },
    { kind: "git_publication_blocked", reason: "spaces", spaces: [] },
    {
      kind: "git_publication_blocked",
      reason: "spaces",
      spaces: [{ path: "develop", class: "future_class" }],
    },
    {
      kind: "git_publication_blocked",
      reason: "spaces",
      spaces: [{ class: "local_commits" }],
    },
  ])
    expect(toGitPublicationBlockDto(error)).toBe(null);
});

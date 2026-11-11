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
    { path: "compliance", class: "local_commits" as const },
    { path: "legal", class: "outside_branch" as const },
  ];
  expect(
    toGitPublicationBlockDto({
      kind: "git_publication_blocked",
      repository: "/project",
      reason: "spaces",
      spaces,
    }),
  ).toEqual({
    kind: "git_publication_blocked",
    reason: "spaces",
    repository: "/project",
    spaces,
  });
});

test("the replaced single-child shape and malformed Spaces are not a refusal", () => {
  for (const error of [
    {
      kind: "git_publication_blocked",
      reason: "uninitialized_child",
      child: "develop",
    },
    { kind: "git_publication_blocked", reason: "spaces" },
    {
      kind: "git_publication_blocked",
      reason: "spaces",
      spaces: [{ path: "develop", class: "local_commits" }],
    },
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

test("a publication guard refusal names the file, commit and finding", () => {
  const guard = {
    kind: "git_publication_blocked",
    repository: "/space",
    reason: "content",
    path: "tasks/schema.yaml",
    commit: "abc",
  };
  for (const finding of ["conflict_markers", "unreadable"] as const)
    expect(toGitPublicationBlockDto({ ...guard, finding })).toEqual({
      kind: "git_publication_blocked",
      reason: "content",
      path: "tasks/schema.yaml",
      commit: "abc",
      finding,
    });
  for (const error of [
    { ...guard, finding: "whitespace" },
    { ...guard, path: undefined, finding: "unreadable" },
    { ...guard, commit: 1, finding: "unreadable" },
  ])
    expect(toGitPublicationBlockDto(error)).toBe(null);
});

import { expect, test } from "bun:test";

import { toRepositoryAccessDeniedDto } from "./repository-access-api";

test("typed repository denial preserves exact late-denial fields", () => {
  expect(
    toRepositoryAccessDeniedDto({
      kind: "repository_access_denied",
      repositoryId: "repo-opaque",
      status: "unknown",
      reason: "mutation_plan_changed",
    }),
  ).toEqual({
    kind: "repository_access_denied",
    repositoryId: "repo-opaque",
    status: "unknown",
    reason: "mutation_plan_changed",
    blockers: [],
  });
  expect(toRepositoryAccessDeniedDto("Repository access denied")).toBeNull();
  expect(
    toRepositoryAccessDeniedDto({
      kind: "repository_access_denied",
      repositoryId: "repo-opaque",
      status: "unknown",
      reason: "unexpected_reason",
    }),
  ).toBeNull();
});

test("typed repository denial keeps every located blocker and drops malformed ones", () => {
  expect(
    toRepositoryAccessDeniedDto({
      cause: {
        kind: "repository_access_denied",
        repositoryId: "repo-b",
        status: "read_only",
        reason: "none",
        blockers: [
          {
            repositoryId: "repo-b",
            repositoryPath: "/project/b",
            status: "read_only",
            reason: "none",
            secret: "SECRET",
          },
          { repositoryId: "repo-x", status: "read_only", reason: "none" },
          {
            repositoryId: "repo-c",
            repositoryPath: "/project/c",
            status: "unknown",
            reason: "not_checked",
          },
        ],
      },
    }),
  ).toEqual({
    kind: "repository_access_denied",
    repositoryId: "repo-b",
    status: "read_only",
    reason: "none",
    blockers: [
      {
        repositoryId: "repo-b",
        repositoryPath: "/project/b",
        status: "read_only",
        reason: "none",
      },
      {
        repositoryId: "repo-c",
        repositoryPath: "/project/c",
        status: "unknown",
        reason: "not_checked",
      },
    ],
  });
});

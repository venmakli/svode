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

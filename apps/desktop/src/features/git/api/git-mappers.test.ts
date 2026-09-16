import { expect, test } from "bun:test";
import { toSyncResult } from "./git-mappers";

test("toSyncResult maps backend camelCase sync results", () => {
  expect(toSyncResult({ type: "success" })).toEqual({ type: "Success" });
  expect(toSyncResult({ type: "noRemote" })).toEqual({ type: "NoRemote" });
  expect(toSyncResult({ type: "authRequired" })).toEqual({
    type: "AuthRequired",
    challenge: null,
  });
  expect(
    toSyncResult({
      type: "authRequired",
      challenge: {
        operation: "first-push",
        authMethod: "https",
        remoteUrl: "https://example.com/org/repo.git",
        host: "example.com",
        repository: "org/repo",
        providerHint: "gitea",
        detail: "Authentication failed",
      },
    }),
  ).toEqual({
    type: "AuthRequired",
    challenge: {
      operation: "first-push",
      authMethod: "https",
      remoteUrl: "https://example.com/org/repo.git",
      host: "example.com",
      repository: "org/repo",
      providerHint: "gitea",
      detail: "Authentication failed",
    },
  });
  expect(toSyncResult({ type: "conflict", files: ["README.md"] })).toEqual({
    type: "Conflict",
    files: ["README.md"],
  });
});

test("child publication retains a separately targeted parent failure", () => {
  const result = toSyncResult({
    type: "success",
    publishedHead: "child-sha",
    parent: {
      repository: "/project",
      pointer: "local",
      error: {
        kind: "git_publication_blocked",
        reason: "revision_unavailable",
      },
    },
  });
  expect(result.type).toBe("Success");
  if (result.type !== "Success") throw new Error("Expected child success");
  expect(result.publishedHead).toBe("child-sha");
  expect(result.parent?.repository).toBe("/project");
  expect(result.parent?.error?.kind).toBe("git_publication_blocked");
  expect(result.parent?.pointer).toBe("local");
});

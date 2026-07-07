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

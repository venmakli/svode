import { expect, test } from "bun:test";
import { toSyncResult } from "./git-mappers";
import {
  serviceMergedFromResult,
  syncStopFromResult,
} from "../model/sync-stop";

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
  expect(
    toSyncResult({
      type: "conflict",
      files: ["README.md", "data.json"],
      kinds: [
        { path: "README.md", kind: "page_text" },
        { path: "data.json", kind: "text" },
      ],
    }),
  ).toEqual({
    type: "Conflict",
    files: ["README.md", "data.json"],
    kinds: [
      { path: "README.md", kind: "page_text" },
      { path: "data.json", kind: "text" },
    ],
  });
  expect(
    toSyncResult({
      type: "unresolved",
      path: "data.json",
      finding: { type: "unreadable", message: "expected value" },
    }),
  ).toEqual({
    type: "Unresolved",
    path: "data.json",
    finding: { type: "unreadable", message: "expected value" },
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

test("toSyncResult keeps the Svode service files a sync merged or left", () => {
  expect(
    toSyncResult({
      type: "success",
      publishedHead: "abc",
      merged: [".svode/order.json"],
    }),
  ).toEqual({
    type: "Success",
    publishedHead: "abc",
    merged: [".svode/order.json"],
  });
  expect(
    toSyncResult({
      type: "conflict",
      files: ["space", "Page.md"],
      merged: [".svode/order.json"],
      service: [{ path: "space", state: "space_diverged" }],
    }),
  ).toEqual({
    type: "Conflict",
    files: ["space", "Page.md"],
    kinds: [],
    merged: [".svode/order.json"],
    service: [{ path: "space", state: "space_diverged" }],
  });
});

test("toSyncResult keeps the files and kinds of a background stop", () => {
  expect(
    toSyncResult({
      type: "incomingConflict",
      files: [{ path: "Page.md", kind: "page_text" }],
    }),
  ).toEqual({
    type: "IncomingConflict",
    files: [{ path: "Page.md", kind: "page_text" }],
  });
  expect(
    toSyncResult({
      type: "incomingConflict",
      files: [{ path: "space", kind: "space_pointer" }],
      service: [{ path: "space", state: "space_unavailable" }],
    }),
  ).toEqual({
    type: "IncomingConflict",
    files: [{ path: "space", kind: "space_pointer" }],
    service: [{ path: "space", state: "space_unavailable" }],
  });
  expect(toSyncResult({ type: "explicitSyncRequired" })).toEqual({
    type: "ExplicitSyncRequired",
  });
});

test("toSyncResult keeps the step and the files in conflict of a stopped operation", () => {
  expect(
    toSyncResult({
      type: "operationInProgress",
      operation: "rebase",
      step: { kind: "position", current: 2, total: 5 },
      files: ["Page.md"],
      kinds: [{ path: "Page.md", kind: "page_text" }],
    }),
  ).toEqual({
    type: "OperationInProgress",
    operation: "rebase",
    step: { kind: "position", current: 2, total: 5 },
    files: ["Page.md"],
    kinds: [{ path: "Page.md", kind: "page_text" }],
  });
  // A sequence carries the commits its abort drops.
  expect(
    toSyncResult({
      type: "operationInProgress",
      operation: "sequencer",
      step: { kind: "remaining", count: 1 },
      sequence: { head: "abc", count: 7, titles: ["Fix typo", "Add intro"] },
    }),
  ).toEqual({
    type: "OperationInProgress",
    operation: "sequencer",
    step: { kind: "remaining", count: 1 },
    sequence: { head: "abc", count: 7, titles: ["Fix typo", "Add intro"] },
    files: [],
    kinds: [],
  });
  // A single pick reports no step; a stop with no file in conflict has none.
  expect(
    toSyncResult({ type: "operationInProgress", operation: "cherry_pick" }),
  ).toEqual({
    type: "OperationInProgress",
    operation: "cherry_pick",
    step: null,
    files: [],
    kinds: [],
  });
});

test("a sync during an agent turn fetches and reports the integration after it, not a stop", () => {
  const result = toSyncResult({ type: "integrationAfterTurn" });
  expect(result).toEqual({ type: "IntegrationAfterTurn" });
  expect(syncStopFromResult(result)).toBe(undefined);
  expect(serviceMergedFromResult(result)).toBe(undefined);
});

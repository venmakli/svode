import { expect, test } from "bun:test";

import {
  beginAgentContextRetry,
  completeAgentContextRefresh,
  failAgentContextRefresh,
  type AgentContextCatalogState,
} from "./catalog-state";
import type { AgentContextInstructionsSnapshot } from "./types";

const snapshot: AgentContextInstructionsSnapshot = {
  adapters: [],
  diagnostics: [],
  generation: 4,
  hasPersonalSources: true,
  rows: [],
  skills: [],
  targetPath: "/workspace/space",
};

test("refresh keeps the last usable snapshot stale until replacement", () => {
  const ready = completeAgentContextRefresh(
    {
      ownerKey: "space:one",
      phase: "initial",
      targetPath: snapshot.targetPath,
    },
    "space:one",
    snapshot.targetPath,
    snapshot,
  );
  const retrying = beginAgentContextRetry(
    ready,
    "space:one",
    snapshot.targetPath,
  );

  expect(retrying.phase).toBe("ready");
  if (retrying.phase !== "ready") throw new Error("Expected ready state");
  expect(retrying.retrying).toBe(true);
  expect(retrying.snapshot).toBe(snapshot);

  const failed = failAgentContextRefresh(
    retrying,
    "space:one",
    snapshot.targetPath,
    "source changed during scan",
  );
  expect(failed.phase).toBe("ready");
  if (failed.phase !== "ready") throw new Error("Expected stale ready state");
  expect(failed.refreshError).toBe("source changed during scan");
  expect(failed.retrying).toBe(false);
  expect(failed.snapshot).toBe(snapshot);

  const retryAfterFailure = beginAgentContextRetry(
    failed,
    "space:one",
    snapshot.targetPath,
  );
  expect(retryAfterFailure.phase).toBe("ready");
  if (retryAfterFailure.phase !== "ready") {
    throw new Error("Expected ready retry state");
  }
  expect(retryAfterFailure.refreshError).toBe("source changed during scan");
  expect(retryAfterFailure.retrying).toBe(true);
});

test("a failure blocks only when no usable snapshot exists", () => {
  const initial: AgentContextCatalogState = {
    ownerKey: "space:one",
    phase: "initial",
    targetPath: snapshot.targetPath,
  };

  expect(
    failAgentContextRefresh(
      initial,
      "space:one",
      snapshot.targetPath,
      "unavailable",
    ),
  ).toEqual({
    error: "unavailable",
    ownerKey: "space:one",
    phase: "blocking_error",
    retrying: false,
    targetPath: snapshot.targetPath,
  });
});

test("a different owner never inherits the previous snapshot", () => {
  const ready = completeAgentContextRefresh(
    {
      ownerKey: "space:one",
      phase: "initial",
      targetPath: snapshot.targetPath,
    },
    "space:one",
    snapshot.targetPath,
    snapshot,
  );

  expect(
    beginAgentContextRetry(ready, "space:two", "/workspace/other"),
  ).toEqual({
    ownerKey: "space:two",
    phase: "initial",
    targetPath: "/workspace/other",
  });
});

test("an equivalent generation keeps the published snapshot identity", () => {
  const initial: AgentContextCatalogState = {
    ownerKey: "space:one",
    phase: "initial",
    targetPath: snapshot.targetPath,
  };
  const ready = completeAgentContextRefresh(
    initial,
    "space:one",
    snapshot.targetPath,
    snapshot,
  );
  const equivalentSnapshot = { ...snapshot };

  expect(
    completeAgentContextRefresh(
      ready,
      "space:one",
      snapshot.targetPath,
      equivalentSnapshot,
    ),
  ).toBe(ready);

  const retrying = beginAgentContextRetry(
    ready,
    "space:one",
    snapshot.targetPath,
  );
  const completed = completeAgentContextRefresh(
    retrying,
    "space:one",
    snapshot.targetPath,
    equivalentSnapshot,
  );
  expect(completed.phase).toBe("ready");
  if (completed.phase !== "ready") throw new Error("Expected ready state");
  expect(completed.snapshot).toBe(snapshot);
  expect(completed.retrying).toBe(false);
});

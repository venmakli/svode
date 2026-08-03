import { expect, test } from "bun:test";

import {
  beginAgentContextRefresh,
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
  targetPath: "/workspace/space",
};

test("refresh keeps the last usable snapshot stale until replacement", () => {
  const ready = completeAgentContextRefresh(
    "space:one",
    snapshot.targetPath,
    snapshot,
  );
  const refreshing = beginAgentContextRefresh(
    ready,
    "space:one",
    snapshot.targetPath,
  );

  expect(refreshing.phase).toBe("ready");
  if (refreshing.phase !== "ready") throw new Error("Expected ready state");
  expect(refreshing.refreshing).toBe(true);
  expect(refreshing.snapshot).toBe(snapshot);

  const failed = failAgentContextRefresh(
    refreshing,
    "space:one",
    snapshot.targetPath,
    "source changed during scan",
  );
  expect(failed.phase).toBe("ready");
  if (failed.phase !== "ready") throw new Error("Expected stale ready state");
  expect(failed.refreshError).toBe("source changed during scan");
  expect(failed.refreshing).toBe(false);
  expect(failed.snapshot).toBe(snapshot);
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
    targetPath: snapshot.targetPath,
  });
});

test("a different owner never inherits the previous snapshot", () => {
  const ready = completeAgentContextRefresh(
    "space:one",
    snapshot.targetPath,
    snapshot,
  );

  expect(
    beginAgentContextRefresh(ready, "space:two", "/workspace/other"),
  ).toEqual({
    ownerKey: "space:two",
    phase: "initial",
    targetPath: "/workspace/other",
  });
});

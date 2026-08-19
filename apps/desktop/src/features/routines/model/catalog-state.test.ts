import { expect, test } from "bun:test";

import {
  beginRoutineCatalogRefresh,
  completeRoutineCatalogRefresh,
  failRoutineCatalogRefresh,
  publishRoutineCatalogSnapshot,
} from "./catalog-state";
import type { RoutineCatalogSnapshot, RoutineCatalogState } from "./types";

const snapshot: RoutineCatalogSnapshot = {
  catalogFingerprint: "routine-catalog:one",
  diagnostics: [],
  ownerPath: "/repo",
  refreshedAt: "2026-08-19T00:00:00.000Z",
  resolvedOwnerKind: "project",
  rows: [],
  spaceId: "root",
};

test("routine refresh preserves ready rows through a background failure", () => {
  const ready = completeRoutineCatalogRefresh(snapshot);
  const refreshing = beginRoutineCatalogRefresh(ready);
  const failed = failRoutineCatalogRefresh(refreshing, "offline");

  expect(failed.phase).toBe("ready");
  expect(failed.phase === "ready" && failed.snapshot).toBe(snapshot);
  expect(failed.phase === "ready" && failed.refreshError).toBe("offline");
});

test("routine retry is contextual and equal fingerprints are a no-op", () => {
  const blocking: RoutineCatalogState = {
    error: "offline",
    phase: "blocking_error",
    retrying: false,
  };
  expect(beginRoutineCatalogRefresh(blocking)).toEqual({
    ...blocking,
    retrying: true,
  });

  const ready = completeRoutineCatalogRefresh(snapshot);
  expect(
    publishRoutineCatalogSnapshot(ready, {
      ...snapshot,
      refreshedAt: "2026-08-19T00:01:00.000Z",
    }),
  ).toBe(ready);
});

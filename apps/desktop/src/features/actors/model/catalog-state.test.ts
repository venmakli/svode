import { expect, test } from "bun:test";

import {
  beginActorCatalogRefresh,
  completeActorCatalogRefresh,
  failActorCatalogRefresh,
  publishActorCatalogSnapshot,
  type ActorCatalogState,
} from "./catalog-state";
import type { ActorCatalogSnapshot } from "./types";

const snapshot: ActorCatalogSnapshot = {
  diagnostics: [],
  generation: 1,
  repositoryId: "/repo",
  rows: [],
  shallow: false,
};

test("refresh keeps the last ready snapshot through pending and failure", () => {
  const ready = completeActorCatalogRefresh("/repo", snapshot);
  const refreshing = beginActorCatalogRefresh(ready, "/repo");
  const failed = failActorCatalogRefresh(refreshing, "/repo", "offline");

  expect(refreshing.phase).toBe("ready");
  expect(refreshing.phase === "ready" && refreshing.snapshot).toBe(snapshot);
  expect(failed.phase).toBe("ready");
  expect(failed.phase === "ready" && failed.snapshot).toBe(snapshot);
  expect(failed.phase === "ready" && failed.refreshError).toBe("offline");
});

test("a first load failure is blocking and a new scope resets to initial", () => {
  const initial: ActorCatalogState = { phase: "initial", spacePath: "/one" };
  const failed = failActorCatalogRefresh(initial, "/one", "failed");
  expect(failed).toEqual({
    error: "failed",
    phase: "blocking_error",
    retrying: false,
    spacePath: "/one",
  });
  expect(beginActorCatalogRefresh(failed, "/one")).toEqual({
    ...failed,
    retrying: true,
  });
  expect(beginActorCatalogRefresh(initial, "/two")).toEqual({
    phase: "initial",
    spacePath: "/two",
  });
});

test("publishing the same generation is a content no-op", () => {
  const ready = completeActorCatalogRefresh("/repo", snapshot);
  expect(publishActorCatalogSnapshot(ready, "/repo", { ...snapshot })).toBe(
    ready,
  );
});

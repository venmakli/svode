import { expect, test } from "bun:test";

import {
  beginActorCatalogRefresh,
  completeActorCatalogRefresh,
  failActorCatalogRefresh,
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
  expect(failActorCatalogRefresh(initial, "/one", "failed").phase).toBe(
    "blocking_error",
  );
  expect(beginActorCatalogRefresh(initial, "/two")).toEqual({
    phase: "initial",
    spacePath: "/two",
  });
});

import { expect, test } from "bun:test";

import {
  beginAgentActorCatalogRefresh,
  failAgentActorCatalogRefresh,
  publishAgentActorCatalogSnapshot,
  type AgentActorCatalogState,
} from "./agent-actor-catalog-state";
import type { AgentActorCatalogSnapshot } from "./agent-actor-types";

const snapshot: AgentActorCatalogSnapshot = {
  adapterDescriptors: [],
  bindingRuntime: {},
  diagnostics: [],
  fingerprints: { "/repo": "fingerprint:one" },
  launchSpacePath: "/repo/docs",
  rows: [],
};

test("agent actor publication suppresses content-equivalent snapshots", () => {
  const ready = publishAgentActorCatalogSnapshot(
    { phase: "initial" },
    snapshot,
  );

  expect(publishAgentActorCatalogSnapshot(ready, { ...snapshot })).toBe(ready);
});

test("agent actor retry preserves stale rows and exposes contextual pending", () => {
  const ready = publishAgentActorCatalogSnapshot(
    { phase: "initial" },
    snapshot,
  );
  const refreshing = beginAgentActorCatalogRefresh(ready);
  const failed = failAgentActorCatalogRefresh(refreshing, "offline");

  expect(failed.phase).toBe("ready");
  expect(failed.phase === "ready" && failed.snapshot).toBe(snapshot);
  expect(failed.phase === "ready" && failed.refreshError).toBe("offline");

  const blocking: AgentActorCatalogState = {
    error: "offline",
    phase: "blocking_error",
    retrying: false,
  };
  expect(beginAgentActorCatalogRefresh(blocking)).toEqual({
    ...blocking,
    retrying: true,
  });
});

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentContextCatalogState } from "../model/catalog-state";
import type { AgentContextSnapshot } from "../model/types";
import { toAgentContextPresentationState } from "./agent-context-presentation-state";

const snapshot: AgentContextSnapshot = {
  diagnostics: [],
  enabledAgents: ["codex"],
  generation: 4,
  hasPersonalSources: true,
  items: [],
  targetPath: "/workspace",
};

test("blocking discovery failure exposes contextual retry", () => {
  const state: AgentContextCatalogState = {
    error: "filesystem unavailable",
    ownerKey: "space:root",
    phase: "blocking_error",
    retrying: false,
    targetPath: snapshot.targetPath,
  };
  const presentation = toAgentContextPresentationState(
    state,
    null,
    () => undefined,
  );
  if (presentation.phase !== "blocking_error") {
    throw new Error("Expected blocking error state");
  }

  const html = renderToStaticMarkup(presentation.error);
  expect(html.includes("filesystem unavailable")).toBe(true);
  expect(html.includes("Retry")).toBe(true);
});

test("ready state keeps rows without product attention or full-width diagnostics", () => {
  const state: AgentContextCatalogState = {
    ownerKey: "space:root",
    phase: "ready",
    refreshError: "scan failed",
    retrying: false,
    snapshot,
    targetPath: snapshot.targetPath,
  };
  const presentation = toAgentContextPresentationState(
    state,
    null,
    () => undefined,
  );
  if (presentation.phase !== "ready") {
    throw new Error("Expected ready state");
  }

  expect(presentation.rows).toBe(snapshot.items);
  expect("attention" in presentation).toBe(false);
  expect("diagnostics" in presentation).toBe(false);
  expect("refreshing" in presentation).toBe(false);
});

test("without an enabled agent one hint above the project items leads to Providers", () => {
  let opened = 0;
  const state: AgentContextCatalogState = {
    ownerKey: "space:root",
    phase: "ready",
    refreshError: null,
    retrying: false,
    snapshot: { ...snapshot, enabledAgents: [] },
    targetPath: snapshot.targetPath,
  };
  const presentation = toAgentContextPresentationState(
    state,
    null,
    () => undefined,
    () => {
      opened += 1;
    },
  );
  if (presentation.phase !== "ready") {
    throw new Error("Expected ready state");
  }

  const html = renderToStaticMarkup(presentation.attention);
  expect(html.includes("Enable an agent in Providers")).toBe(true);
  expect(html.includes("Open Providers")).toBe(true);
  expect(opened).toBe(0);
});

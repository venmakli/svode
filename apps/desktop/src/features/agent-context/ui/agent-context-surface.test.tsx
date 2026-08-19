import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentContextCatalogState } from "../model/catalog-state";
import type { AgentContextInstructionsSnapshot } from "../model/types";
import { toAgentContextPresentationState } from "./agent-context-presentation-state";

const snapshot: AgentContextInstructionsSnapshot = {
  adapters: [],
  generation: 4,
  hasPersonalSources: true,
  instructionDiagnostics: [],
  rows: [],
  skillDiagnostics: [],
  skills: [],
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
    (value) => value.rows,
    (value) => value.instructionDiagnostics,
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

test("background failure keeps rows and adds retry without busy chrome", () => {
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
    (value) => value.rows,
    (value) => value.instructionDiagnostics,
    null,
    () => undefined,
  );
  if (presentation.phase !== "ready") {
    throw new Error("Expected ready state");
  }

  const html = renderToStaticMarkup(<>{presentation.diagnostics}</>);
  expect(presentation.rows).toBe(snapshot.rows);
  expect(html.includes("Retry")).toBe(true);
  expect(html.includes("Updating")).toBe(false);
  expect("refreshing" in presentation).toBe(false);
});

import { expect, test } from "bun:test";
import { useShellStore } from "./shell-store";
import { createDefaultKnowledgeFilters } from "@/features/knowledge";

test("graph handoff transfers query, scope, and selection without replacing content state", () => {
  useShellStore.setState({
    mainSurface: "content",
    knowledgeGraphOpenRequest: null,
    nextKnowledgeGraphOpenRequestKey: 1,
  });

  useShellStore.getState().openGraphSurface({
    query: "architecture",
    scope: { kind: "space", spaceId: "child" },
    filters: createDefaultKnowledgeFilters(),
    selectedNodeId: "page:child:notes.md",
  });

  expect(useShellStore.getState().mainSurface).toBe("graph");
  expect(useShellStore.getState().knowledgeGraphOpenRequest).toEqual({
    query: "architecture",
    scope: { kind: "space", spaceId: "child" },
    filters: createDefaultKnowledgeFilters(),
    selectedNodeId: "page:child:notes.md",
    requestKey: 1,
  });

  useShellStore.getState().openContentSurface();
  expect(useShellStore.getState().mainSurface).toBe("content");
  expect(useShellStore.getState().knowledgeGraphOpenRequest?.query).toBe(
    "architecture",
  );
});

test("repository recovery opens the exact space settings Git destination", () => {
  useShellStore.setState({
    settingsDialog: null,
    settingsSpaceDestination: "general",
    settingsSpacePath: null,
  });

  useShellStore.getState().openSpaceSettings("/project/spaces/docs", "git");

  expect(useShellStore.getState().settingsDialog).toBe("space");
  expect(useShellStore.getState().settingsSpaceDestination).toBe("git");
  expect(useShellStore.getState().settingsSpacePath).toBe(
    "/project/spaces/docs",
  );

  useShellStore.getState().closeSettings();
  expect(useShellStore.getState().settingsSpaceDestination).toBe("general");
  expect(useShellStore.getState().settingsSpacePath).toBeNull();
});

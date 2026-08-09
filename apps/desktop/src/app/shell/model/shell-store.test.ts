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
    selectedNodeId: "document:child:README.md",
  });

  expect(useShellStore.getState().mainSurface).toBe("graph");
  expect(useShellStore.getState().knowledgeGraphOpenRequest).toEqual({
    query: "architecture",
    scope: { kind: "space", spaceId: "child" },
    filters: createDefaultKnowledgeFilters(),
    selectedNodeId: "document:child:README.md",
    requestKey: 1,
  });

  useShellStore.getState().openContentSurface();
  expect(useShellStore.getState().mainSurface).toBe("content");
  expect(useShellStore.getState().knowledgeGraphOpenRequest?.query).toBe(
    "architecture",
  );
});

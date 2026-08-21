import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeSnapshotState } from "../hooks/use-knowledge-snapshot";
import type { KnowledgeSnapshot } from "../model/types";
import { KnowledgeGraphView } from "./knowledge-graph-view";
import { KnowledgeStatus } from "./knowledge-status";
import * as m from "@/paraglide/messages.js";

test("keeps loading and empty error recovery available without a canvas", () => {
  const loadingHtml = renderToStaticMarkup(
    <KnowledgeGraphView
      state={state(null, { loading: true })}
      selectedNodeId={null}
      matchedNodeIds={new Set()}
      resetKey={0}
      onNodeSelect={() => undefined}
      showStatus={false}
    />,
  );
  expect(loadingHtml.includes(m.knowledge_graph_loading())).toBe(true);

  const errorHtml = renderToStaticMarkup(
    <KnowledgeGraphView
      state={state(snapshot("error"), { error: "Index unavailable" })}
      selectedNodeId={null}
      matchedNodeIds={new Set()}
      resetKey={0}
      onNodeSelect={() => undefined}
      showStatus={false}
    />,
  );
  expect(errorHtml.includes(m.knowledge_graph_error())).toBe(true);
  expect(errorHtml.includes(m.knowledge_graph_retry())).toBe(true);
  expect(errorHtml.includes(m.knowledge_graph_rebuild())).toBe(true);
});

test("projects partial freshness and counts into the Sidebar footer", () => {
  const partialSnapshot = {
    ...snapshot("partial"),
    readablePools: 1,
    totalPools: 2,
    totalNodeCount: 7,
    totalEdgeCount: 4,
  };
  const html = renderToStaticMarkup(
    <KnowledgeStatus state={state(partialSnapshot)} placement="inline" />,
  );

  expect(html.includes(m.knowledge_graph_status_partial())).toBe(true);
  expect(
    html.includes(m.knowledge_graph_status_counts({ nodes: 7, edges: 4 })),
  ).toBe(true);
});

function state(
  value: KnowledgeSnapshot | null,
  overrides: Partial<KnowledgeSnapshotState> = {},
): KnowledgeSnapshotState {
  return {
    snapshot: value,
    loading: false,
    error: null,
    mode: "compact",
    projectionKey: "test",
    retry: () => undefined,
    repair: async () => undefined,
    repairing: false,
    repairError: null,
    ...overrides,
  };
}

function snapshot(status: KnowledgeSnapshot["status"]): KnowledgeSnapshot {
  return {
    status,
    nodes: [],
    edges: [],
    searchItems: [],
    freshness: [],
    diagnostics: [],
    readablePools: 1,
    totalPools: 1,
    truncated: false,
    totalNodeCount: 0,
    totalEdgeCount: 0,
    omittedNodeCount: 0,
    omittedEdgeCount: 0,
    nextNodeOffset: null,
    nextEdgeOffset: null,
    hasMoreNodes: false,
    hasMoreEdges: false,
  };
}

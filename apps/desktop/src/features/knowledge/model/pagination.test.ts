import { expect, test } from "bun:test";
import { mergeKnowledgePages } from "./pagination";
import type { KnowledgeEdge, KnowledgeNode, KnowledgeSnapshot } from "./types";

test("knowledge pagination merges pages without duplicates", () => {
  const first = snapshot([node("a"), node("b")], [edge("a", "b", 1)], {
    nextNodeOffset: 2,
    nextEdgeOffset: 1,
    hasMoreNodes: true,
    hasMoreEdges: true,
  });
  const second = snapshot(
    [node("b"), node("c")],
    [edge("a", "b", 1), edge("b", "c", 2)],
  );

  const merged = mergeKnowledgePages(first, second);

  expect(merged.nodes.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  expect(merged.edges.length).toBe(2);
  expect(merged.truncated).toBe(false);
  expect(merged.omittedNodeCount).toBe(0);
  expect(merged.omittedEdgeCount).toBe(0);
});

function snapshot(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  pagination: Partial<KnowledgeSnapshot> = {},
): KnowledgeSnapshot {
  return {
    status: "complete",
    nodes,
    edges,
    searchItems: [],
    freshness: [],
    diagnostics: [],
    readablePools: 1,
    totalPools: 1,
    truncated: nodes.length < 3 || edges.length < 2,
    totalNodeCount: 3,
    totalEdgeCount: 2,
    omittedNodeCount: Math.max(0, 3 - nodes.length),
    omittedEdgeCount: Math.max(0, 2 - edges.length),
    nextNodeOffset: null,
    nextEdgeOffset: null,
    hasMoreNodes: false,
    hasMoreEdges: false,
    ...pagination,
  };
}

function node(id: string): KnowledgeNode {
  return {
    id,
    source: { spaceId: null, path: `${id}.md`, kind: "document" },
    spaceName: "Root",
    title: id,
    contentHash: id,
    sourceUpdatedAt: "2026-08-09T00:00:00Z",
    checkedAt: "2026-08-09T00:00:00Z",
    canonicalSourcePath: `${id}.md`,
    provenance: {},
  };
}

function edge(
  sourceId: string,
  targetId: string,
  byteStart: number,
): KnowledgeEdge {
  return {
    kind: "links_to",
    sourceId,
    source: { spaceId: null, path: `${sourceId}.md`, kind: "document" },
    targetId,
    target: { spaceId: null, path: `${targetId}.md`, kind: "document" },
    targetUrl: `${targetId}.md`,
    targetStatus: "ready",
    origin: "explicit",
    fieldName: null,
    locationPath: `${sourceId}.md`,
    byteStart,
    byteEnd: byteStart + 1,
  };
}

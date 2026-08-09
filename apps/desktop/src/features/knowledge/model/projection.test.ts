import { expect, test } from "bun:test";
import {
  getDirectNeighborDetails,
  getDirectNeighbors,
  getMatchedNodeIds,
  getNodeById,
  withSearchResultNodes,
} from "./projection";
import type { KnowledgeSnapshot } from "./types";

const snapshot: KnowledgeSnapshot = {
  status: "complete",
  nodes: [
    node("document:root:a.md", "a.md"),
    node("document:root:b.md", "b.md"),
    node("document:root:c.md", "c.md"),
  ],
  edges: [
    edge("document:root:a.md", "document:root:b.md"),
    edge("document:root:c.md", "document:root:a.md"),
  ],
  searchItems: [
    {
      nodeId: "document:root:b.md",
      source: { kind: "document", spaceId: null, path: "b.md" },
      spaceName: "Root",
      title: "B",
      snippet: null,
      locationPath: "b.md",
      lineStart: 1,
      lineEnd: 1,
    },
  ],
  freshness: [],
  diagnostics: [],
  readablePools: 1,
  totalPools: 1,
  truncated: false,
  totalNodeCount: 3,
  totalEdgeCount: 2,
  omittedNodeCount: 0,
  omittedEdgeCount: 0,
  nextNodeOffset: null,
  nextEdgeOffset: null,
  hasMoreNodes: false,
  hasMoreEdges: false,
};

test("knowledge graph finds a selected node and both neighbor directions", () => {
  expect(getNodeById(snapshot, "document:root:a.md")?.title).toBe("a.md");
  expect(
    getDirectNeighbors(snapshot, "document:root:a.md").map(
      (item) => item.source.path,
    ),
  ).toEqual(["b.md", "c.md"]);
  expect(
    getDirectNeighborDetails(snapshot, "document:root:a.md").map(
      ({ node: item, edgeKinds, fieldNames }) => [
        item?.source.path,
        edgeKinds,
        fieldNames,
      ],
    ),
  ).toEqual([
    ["b.md", ["links_to"], []],
    ["c.md", ["links_to"], []],
  ]);
});

test("knowledge graph uses backend search projection for focus", () => {
  expect([...getMatchedNodeIds(snapshot, "b")]).toEqual(["document:root:b.md"]);
  expect(getMatchedNodeIds(snapshot, "").size).toBe(0);
});

test("knowledge graph keeps a bounded search result visible as its logical node", () => {
  const resultOnlySnapshot: KnowledgeSnapshot = {
    ...snapshot,
    nodes: snapshot.nodes.slice(0, 1),
    omittedNodeCount: 2,
  };
  const projected = withSearchResultNodes(resultOnlySnapshot);
  expect(projected?.nodes.map(({ id }) => id)).toEqual([
    "document:root:a.md",
    "document:root:b.md",
  ]);
  expect(projected?.omittedNodeCount).toBe(1);
  expect(projected?.nodes.at(-1)?.canonicalSourcePath).toBe("b.md");
});

function node(id: string, path: string) {
  return {
    id,
    source: { kind: "document" as const, spaceId: null, path },
    spaceName: "Root",
    title: path,
    contentHash: id,
    sourceUpdatedAt: "2026-08-08T00:00:00Z",
    checkedAt: "2026-08-08T00:00:00Z",
    canonicalSourcePath: path,
    provenance: {},
  };
}

function edge(sourceId: string, targetId: string) {
  const sourcePath = sourceId.split(":").at(-1) ?? "";
  const targetPath = targetId.split(":").at(-1) ?? "";
  return {
    kind: "links_to" as const,
    sourceId,
    source: { kind: "document" as const, spaceId: null, path: sourcePath },
    targetId,
    target: { kind: "document" as const, spaceId: null, path: targetPath },
    targetUrl: targetPath,
    targetStatus: "ready" as const,
    origin: "explicit" as const,
    fieldName: null,
    locationPath: sourcePath,
    byteStart: 0,
    byteEnd: 1,
  };
}

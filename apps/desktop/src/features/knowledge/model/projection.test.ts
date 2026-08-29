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
    node("page:root:a.md", "a.md"),
    node("page:root:b.md", "b.md"),
    node("page:root:c.md", "c.md"),
  ],
  edges: [
    edge("page:root:a.md", "page:root:b.md"),
    edge("page:root:c.md", "page:root:a.md"),
  ],
  searchItems: [
    {
      nodeId: "page:root:b.md",
      source: { kind: "page", spaceId: null, path: "b.md" },
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
  expect(getNodeById(snapshot, "page:root:a.md")?.title).toBe("a.md");
  expect(
    getDirectNeighbors(snapshot, "page:root:a.md").map(
      (item) => item.source.path,
    ),
  ).toEqual(["b.md", "c.md"]);
  expect(
    getDirectNeighborDetails(snapshot, "page:root:a.md").map(
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
  expect([...getMatchedNodeIds(snapshot, "b")]).toEqual(["page:root:b.md"]);
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
    "page:root:a.md",
    "page:root:b.md",
  ]);
  expect(projected?.omittedNodeCount).toBe(1);
  expect(projected?.nodes.at(-1)?.canonicalSourcePath).toBe("b.md");
});

function node(id: string, path: string) {
  return {
    id,
    source: { kind: "page" as const, spaceId: null, path },
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
    source: { kind: "page" as const, spaceId: null, path: sourcePath },
    targetId,
    target: { kind: "page" as const, spaceId: null, path: targetPath },
    targetUrl: targetPath,
    targetStatus: "ready" as const,
    origin: "explicit" as const,
    fieldName: null,
    locationPath: sourcePath,
    byteStart: 0,
    byteEnd: 1,
  };
}

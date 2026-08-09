import { expect, test } from "bun:test";
import {
  getDirectNeighbors,
  getMatchedNodeIds,
  getNodeById,
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
});

test("knowledge graph uses backend search projection for focus", () => {
  expect([...getMatchedNodeIds(snapshot, "b")]).toEqual(["document:root:b.md"]);
  expect(getMatchedNodeIds(snapshot, "").size).toBe(0);
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
  };
}

function edge(sourceId: string, targetId: string) {
  const sourcePath = sourceId.split(":").at(-1) ?? "";
  const targetPath = targetId.split(":").at(-1) ?? "";
  return {
    sourceId,
    source: { kind: "document" as const, spaceId: null, path: sourcePath },
    targetId,
    target: { kind: "document" as const, spaceId: null, path: targetPath },
    targetUrl: targetPath,
    targetStatus: "ready" as const,
    origin: "explicit" as const,
    byteStart: 0,
    byteEnd: 1,
  };
}

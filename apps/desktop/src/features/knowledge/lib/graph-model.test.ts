import { expect, test } from "bun:test";
import { buildGraphRenderData, resetGraphRenderPositions } from "./graph-model";
import type { KnowledgeEdge, KnowledgeNode } from "../model/types";

test("graph renderer simulates connected nodes and fixes orphan nodes outside the core", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const data = buildGraphRenderData({
    nodes,
    edges: [edge("a", "b")],
    totalNodeCount: nodes.length,
    previousNodes: [],
  });

  expect(data.neighbors.get("a")).toEqual(new Set(["b"]));
  expect(data.nodes.find(({ id }) => id === "a")?.connected).toBe(true);
  expect(data.nodes.find(({ id }) => id === "a")?.fx).toBe(undefined);
  const orphan = data.nodes.find(({ id }) => id === "c");
  expect(orphan?.connected).toBe(false);
  expect(orphan?.fx).toBe(orphan?.x);
  expect(orphan?.fy).toBe(orphan?.y);
});

test("graph renderer preserves runtime coordinates across progressive pages", () => {
  const first = buildGraphRenderData({
    nodes: [node("a"), node("b")],
    edges: [edge("a", "b")],
    totalNodeCount: 3,
    previousNodes: [],
  });
  const a = first.nodes[0];
  a.x = 123;
  a.y = 456;

  const second = buildGraphRenderData({
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("a", "b")],
    totalNodeCount: 3,
    previousNodes: first.nodes,
  });

  expect(second.nodes[0]).toBe(a);
  expect(second.nodes[0].x).toBe(123);
  expect(second.nodes[0].y).toBe(456);
});

test("graph renderer reset produces deterministic positions without one orphan radius", () => {
  const nodes = Array.from({ length: 24 }, (_, index) => node(`n${index}`));
  const data = buildGraphRenderData({
    nodes,
    edges: [],
    totalNodeCount: 1_000,
    previousNodes: [],
  });
  resetGraphRenderPositions(data.nodes, 1_000);
  const firstPositions = data.nodes.map(({ x, y }) => [x, y]);
  const radii = new Set(
    data.nodes.map(({ x = 0, y = 0 }) => Math.round(Math.hypot(x, y))),
  );

  resetGraphRenderPositions(data.nodes, 1_000);

  expect(data.nodes.map(({ x, y }) => [x, y])).toEqual(firstPositions);
  expect(radii.size > 12).toBe(true);
});

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

function edge(sourceId: string, targetId: string): KnowledgeEdge {
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
    byteStart: 0,
    byteEnd: 1,
  };
}

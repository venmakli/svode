import type { KnowledgeEdge, KnowledgeSnapshot } from "./types";

export function mergeKnowledgePages(
  current: KnowledgeSnapshot | null,
  page: KnowledgeSnapshot,
): KnowledgeSnapshot {
  if (!current) return page;

  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  for (const node of page.nodes) nodes.set(node.id, node);

  const edges = new Map(
    current.edges.map((edge) => [knowledgeEdgeKey(edge), edge]),
  );
  for (const edge of page.edges) edges.set(knowledgeEdgeKey(edge), edge);

  const searchItems = new Map(
    current.searchItems.map((item) => [item.nodeId, item]),
  );
  for (const item of page.searchItems) searchItems.set(item.nodeId, item);

  const mergedNodes = [...nodes.values()];
  const mergedEdges = [...edges.values()];
  const omittedNodeCount = Math.max(
    0,
    page.totalNodeCount - mergedNodes.length,
  );
  const omittedEdgeCount = Math.max(
    0,
    page.totalEdgeCount - mergedEdges.length,
  );

  return {
    ...page,
    nodes: mergedNodes,
    edges: mergedEdges,
    searchItems: [...searchItems.values()],
    truncated: omittedNodeCount > 0 || omittedEdgeCount > 0,
    omittedNodeCount,
    omittedEdgeCount,
  };
}

export function knowledgeEdgeKey(edge: KnowledgeEdge): string {
  return [
    edge.kind,
    edge.sourceId,
    edge.targetId ?? "",
    edge.targetUrl,
    edge.byteStart,
    edge.byteEnd,
  ].join("\u0000");
}

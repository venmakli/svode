import type { KnowledgeEdge, KnowledgeNode, KnowledgeSnapshot } from "./types";

export function getNodeById(
  snapshot: KnowledgeSnapshot | null,
  nodeId: string | null,
): KnowledgeNode | null {
  if (!snapshot || !nodeId) return null;
  return snapshot.nodes.find((node) => node.id === nodeId) ?? null;
}

export function getDirectNeighbors(
  snapshot: KnowledgeSnapshot | null,
  nodeId: string | null,
): KnowledgeNode[] {
  if (!snapshot || !nodeId) return [];
  const ids = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edge.sourceId === nodeId && edge.targetId) ids.add(edge.targetId);
    if (edge.targetId === nodeId) ids.add(edge.sourceId);
  }
  return snapshot.nodes.filter((node) => ids.has(node.id));
}

export function getConnectedEdgeIds(
  edges: KnowledgeEdge[],
  nodeId: string | null,
): Set<number> {
  const result = new Set<number>();
  if (!nodeId) return result;
  edges.forEach((edge, index) => {
    if (edge.sourceId === nodeId || edge.targetId === nodeId) result.add(index);
  });
  return result;
}

export function getMatchedNodeIds(
  snapshot: KnowledgeSnapshot | null,
  query: string,
): Set<string> {
  if (!snapshot || query.trim() === "") return new Set();
  return new Set(snapshot.searchItems.map((item) => item.nodeId));
}

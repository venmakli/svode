import type {
  KnowledgeEdge,
  KnowledgeEdgeKind,
  KnowledgeNode,
  KnowledgeSource,
  KnowledgeSnapshot,
} from "./types";

export interface KnowledgeNeighbor {
  key: string;
  node: KnowledgeNode | null;
  nodeId: string | null;
  source: KnowledgeSource | null;
  title: string;
  targetStatus: "ready" | "broken";
  edgeKinds: KnowledgeEdgeKind[];
  fieldNames: string[];
}

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
  return getDirectNeighborDetails(snapshot, nodeId).flatMap(({ node }) =>
    node ? [node] : [],
  );
}

export function getDirectNeighborDetails(
  snapshot: KnowledgeSnapshot | null,
  nodeId: string | null,
  additionalEdges: KnowledgeEdge[] = [],
): KnowledgeNeighbor[] {
  if (!snapshot || !nodeId) return [];
  const byKey = new Map<string, KnowledgeNeighbor>();
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const edge of [...snapshot.edges, ...additionalEdges]) {
    const outgoing = edge.sourceId === nodeId;
    const neighborId =
      edge.sourceId === nodeId && edge.targetId
        ? edge.targetId
        : edge.targetId === nodeId
          ? edge.sourceId
          : null;
    const source = outgoing ? edge.target : edge.source;
    const key = neighborId ?? `${edge.kind}:${source?.path ?? edge.targetUrl}`;
    if (!outgoing && !neighborId) continue;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.edgeKinds.includes(edge.kind)) {
        existing.edgeKinds.push(edge.kind);
      }
      if (edge.fieldName && !existing.fieldNames.includes(edge.fieldName)) {
        existing.fieldNames.push(edge.fieldName);
      }
      if (existing.targetStatus === "broken") {
        existing.targetStatus = edge.targetStatus;
      }
      continue;
    }
    const node = neighborId ? (nodesById.get(neighborId) ?? null) : null;
    byKey.set(key, {
      key,
      node,
      nodeId: neighborId,
      source: node?.source ?? source,
      title: node?.title || source?.path || edge.targetUrl,
      targetStatus: edge.targetStatus,
      edgeKinds: [edge.kind],
      fieldNames: edge.fieldName ? [edge.fieldName] : [],
    });
  }
  return [...byKey.values()];
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

export function withSearchResultNodes(
  snapshot: KnowledgeSnapshot | null,
): KnowledgeSnapshot | null {
  if (!snapshot || snapshot.searchItems.length === 0) return snapshot;
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const item of snapshot.searchItems) {
    if (nodes.has(item.nodeId)) continue;
    nodes.set(item.nodeId, {
      id: item.nodeId,
      source: item.source,
      spaceName: item.spaceName,
      title: item.title,
      contentHash: `search:${item.nodeId}`,
      sourceUpdatedAt: "",
      checkedAt:
        snapshot.freshness.find(
          (freshness) => freshness.spaceId === item.source.spaceId,
        )?.checkedAt ?? "",
      canonicalSourcePath: item.locationPath ?? item.source.path,
      provenance: {},
    });
  }
  if (nodes.size === snapshot.nodes.length) return snapshot;
  const visibleNodes = [...nodes.values()];
  const omittedNodeCount = Math.max(
    0,
    snapshot.totalNodeCount - visibleNodes.length,
  );
  return {
    ...snapshot,
    nodes: visibleNodes,
    omittedNodeCount,
    truncated: omittedNodeCount > 0 || snapshot.omittedEdgeCount > 0,
  };
}

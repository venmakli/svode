export type KnowledgeScope =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export interface KnowledgeSource {
  spaceId: string | null;
  path: string;
  kind: "document";
}

export interface KnowledgeNode {
  id: string;
  source: KnowledgeSource;
  spaceName: string;
  title: string;
  contentHash: string;
  sourceUpdatedAt: string;
  checkedAt: string;
}

export interface KnowledgeEdge {
  sourceId: string;
  source: KnowledgeSource;
  targetId: string | null;
  target: KnowledgeSource | null;
  targetUrl: string;
  targetStatus: "ready" | "broken";
  origin: "explicit";
  byteStart: number;
  byteEnd: number;
}

export interface KnowledgeSearchItem {
  nodeId: string;
  source: KnowledgeSource;
  spaceName: string;
  title: string;
  snippet: string | null;
}

export interface KnowledgePoolFreshness {
  spaceId: string | null;
  checkedAt: string;
  documentCount: number;
  linkCount: number;
  skippedCount: number;
  failureCount: number;
}

export interface KnowledgeDiagnostic {
  spaceId: string | null;
  code: string;
  message: string;
}

export interface KnowledgeSnapshot {
  status: "complete" | "partial" | "empty" | "error";
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  searchItems: KnowledgeSearchItem[];
  freshness: KnowledgePoolFreshness[];
  diagnostics: KnowledgeDiagnostic[];
  readablePools: number;
  totalPools: number;
  truncated: boolean;
  totalNodeCount: number;
  totalEdgeCount: number;
  omittedNodeCount: number;
  omittedEdgeCount: number;
  nextNodeOffset: number | null;
  nextEdgeOffset: number | null;
  hasMoreNodes: boolean;
  hasMoreEdges: boolean;
}

export interface KnowledgeGraphState {
  query: string;
  scope: KnowledgeScope;
  selectedNodeId: string | null;
}

export interface KnowledgeSpaceOption {
  id: string | null;
  name: string;
}

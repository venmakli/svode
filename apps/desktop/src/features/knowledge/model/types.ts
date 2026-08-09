export type KnowledgeScope =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export type KnowledgeNodeKind =
  | "document"
  | "collection"
  | "entry"
  | "agent_instruction"
  | "skill";

export type KnowledgeEdgeKind =
  | "links_to"
  | "relation"
  | "member_of"
  | "references";

export interface KnowledgeGraphFilters {
  nodeKinds: KnowledgeNodeKind[];
  edgeKinds: KnowledgeEdgeKind[];
}

export interface KnowledgeSource {
  spaceId: string | null;
  path: string;
  kind: KnowledgeNodeKind;
}

export interface KnowledgeNode {
  id: string;
  source: KnowledgeSource;
  spaceName: string;
  title: string;
  contentHash: string;
  sourceUpdatedAt: string;
  checkedAt: string;
  canonicalSourcePath: string;
  provenance: Record<string, unknown>;
}

export interface KnowledgeEdge {
  kind: KnowledgeEdgeKind;
  sourceId: string;
  source: KnowledgeSource;
  targetId: string | null;
  target: KnowledgeSource | null;
  targetUrl: string;
  targetStatus: "ready" | "broken";
  origin: "explicit";
  fieldName: string | null;
  locationPath: string;
  byteStart: number;
  byteEnd: number;
}

export interface KnowledgeSearchItem {
  nodeId: string;
  source: KnowledgeSource;
  spaceName: string;
  title: string;
  snippet: string | null;
  locationPath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface KnowledgePoolFreshness {
  spaceId: string | null;
  checkedAt: string;
  documentCount: number;
  linkCount: number;
  skippedCount: number;
  failureCount: number;
  stale: boolean;
}

export interface KnowledgeDiagnostic {
  spaceId: string | null;
  code: string;
  message: string;
}

export interface KnowledgeSnapshot {
  status: "complete" | "partial" | "empty" | "error" | "stale";
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
  filters: KnowledgeGraphFilters;
  selectedNodeId: string | null;
}

export interface KnowledgeSpaceOption {
  id: string | null;
  name: string;
}

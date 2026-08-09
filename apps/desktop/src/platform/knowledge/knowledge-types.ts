export type KnowledgeScopeDto =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export type KnowledgeNodeKindDto =
  | "document"
  | "collection"
  | "entry"
  | "agent_instruction"
  | "skill";

export type KnowledgeEdgeKindDto =
  | "links_to"
  | "relation"
  | "member_of"
  | "references";

export interface KnowledgeSourceDto {
  spaceId: string | null;
  path: string;
  kind: KnowledgeNodeKindDto;
}

export interface KnowledgeNodeDto {
  id: string;
  source: KnowledgeSourceDto;
  spaceName: string;
  title: string;
  contentHash: string;
  sourceUpdatedAt: string;
  checkedAt: string;
  canonicalSourcePath: string;
  provenance: Record<string, unknown>;
}

export interface KnowledgeEdgeDto {
  kind: KnowledgeEdgeKindDto;
  sourceId: string;
  source: KnowledgeSourceDto;
  targetId: string | null;
  target: KnowledgeSourceDto | null;
  targetUrl: string;
  targetStatus: "ready" | "broken";
  origin: "explicit";
  fieldName: string | null;
  locationPath: string;
  byteStart: number;
  byteEnd: number;
}

export interface KnowledgeSearchItemDto {
  nodeId: string;
  source: KnowledgeSourceDto;
  spaceName: string;
  title: string;
  snippet: string | null;
  locationPath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface KnowledgePoolFreshnessDto {
  spaceId: string | null;
  checkedAt: string;
  documentCount: number;
  linkCount: number;
  skippedCount: number;
  failureCount: number;
  stale: boolean;
}

export interface KnowledgeDiagnosticDto {
  spaceId: string | null;
  code: string;
  message: string;
}

export interface KnowledgeResponseDto {
  status: "complete" | "partial" | "empty" | "error" | "stale";
  nodes: KnowledgeNodeDto[];
  edges: KnowledgeEdgeDto[];
  searchItems: KnowledgeSearchItemDto[];
  freshness: KnowledgePoolFreshnessDto[];
  diagnostics: KnowledgeDiagnosticDto[];
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

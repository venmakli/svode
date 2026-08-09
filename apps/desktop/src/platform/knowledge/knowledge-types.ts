export type KnowledgeScopeDto =
  | { kind: "project" }
  | { kind: "space"; spaceId: string | null };

export interface KnowledgeSourceDto {
  spaceId: string | null;
  path: string;
  kind: "document";
}

export interface KnowledgeNodeDto {
  id: string;
  source: KnowledgeSourceDto;
  spaceName: string;
  title: string;
  contentHash: string;
  sourceUpdatedAt: string;
  checkedAt: string;
}

export interface KnowledgeEdgeDto {
  sourceId: string;
  source: KnowledgeSourceDto;
  targetId: string | null;
  target: KnowledgeSourceDto | null;
  targetUrl: string;
  targetStatus: "ready" | "broken";
  origin: "explicit";
  byteStart: number;
  byteEnd: number;
}

export interface KnowledgeSearchItemDto {
  nodeId: string;
  source: KnowledgeSourceDto;
  spaceName: string;
  title: string;
  snippet: string | null;
}

export interface KnowledgePoolFreshnessDto {
  spaceId: string | null;
  checkedAt: string;
  documentCount: number;
  linkCount: number;
  skippedCount: number;
  failureCount: number;
}

export interface KnowledgeDiagnosticDto {
  spaceId: string | null;
  code: string;
  message: string;
}

export interface KnowledgeResponseDto {
  status: "complete" | "partial" | "empty" | "error";
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

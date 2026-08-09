import type {
  KnowledgeEdgeKind,
  KnowledgeGraphFilters,
  KnowledgeNodeKind,
} from "./types";

export const KNOWLEDGE_NODE_KINDS = [
  "document",
  "collection",
  "entry",
  "agent_instruction",
  "skill",
] as const satisfies readonly KnowledgeNodeKind[];

export const KNOWLEDGE_EDGE_KINDS = [
  "links_to",
  "relation",
  "member_of",
  "references",
] as const satisfies readonly KnowledgeEdgeKind[];

export function createDefaultKnowledgeFilters(): KnowledgeGraphFilters {
  return {
    nodeKinds: [...KNOWLEDGE_NODE_KINDS],
    edgeKinds: [...KNOWLEDGE_EDGE_KINDS],
  };
}

export function countHiddenKnowledgeKinds(filters: KnowledgeGraphFilters) {
  return (
    KNOWLEDGE_NODE_KINDS.length -
    filters.nodeKinds.length +
    KNOWLEDGE_EDGE_KINDS.length -
    filters.edgeKinds.length
  );
}

export function toggleKnowledgeNodeKind(
  filters: KnowledgeGraphFilters,
  kind: KnowledgeNodeKind,
  checked: boolean,
): KnowledgeGraphFilters {
  return {
    ...filters,
    nodeKinds: toggleKind(filters.nodeKinds, kind, checked),
  };
}

export function toggleKnowledgeEdgeKind(
  filters: KnowledgeGraphFilters,
  kind: KnowledgeEdgeKind,
  checked: boolean,
): KnowledgeGraphFilters {
  return {
    ...filters,
    edgeKinds: toggleKind(filters.edgeKinds, kind, checked),
  };
}

function toggleKind<T extends string>(values: T[], kind: T, checked: boolean) {
  if (checked) {
    return values.includes(kind) ? values : [...values, kind];
  }
  return values.filter((value) => value !== kind);
}

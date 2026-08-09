import { useEffect, useRef, useState } from "react";
import { getKnowledgeSnapshot } from "../api/knowledge-api";
import type {
  KnowledgeEdge,
  KnowledgeGraphFilters,
  KnowledgeNode,
  KnowledgeNodeKind,
  KnowledgeEdgeKind,
  KnowledgeScope,
} from "../model/types";

const NEIGHBOR_LIMIT = 40;

export interface KnowledgeNeighborState {
  edges: KnowledgeEdge[];
  loading: boolean;
  error: string | null;
}

export function useKnowledgeNeighbors(
  projectPath: string | null,
  scope: KnowledgeScope,
  filters: KnowledgeGraphFilters,
  node: KnowledgeNode | null,
): KnowledgeNeighborState {
  const requestId = useRef(0);
  const scopeSpaceId = scope.kind === "space" ? scope.spaceId : null;
  const nodeKindsKey = [...filters.nodeKinds].sort().join(",");
  const edgeKindsKey = [...filters.edgeKinds].sort().join(",");
  const sourceKey = node
    ? `${node.source.spaceId ?? "root"}:${node.source.kind}:${node.source.path}`
    : "";
  const [state, setState] = useState<KnowledgeNeighborState>({
    edges: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    const currentRequest = ++requestId.current;
    let cancelled = false;
    if (!projectPath || !node) {
      queueMicrotask(() => {
        if (!cancelled && currentRequest === requestId.current) {
          setState({ edges: [], loading: false, error: null });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled && currentRequest === requestId.current) {
        setState((previous) => ({ ...previous, loading: true, error: null }));
      }
    });
    const scopeInput =
      scope.kind === "project"
        ? ({ kind: "project" } as const)
        : ({ kind: "space", spaceId: scopeSpaceId } as const);

    void getKnowledgeSnapshot({
      projectPath,
      scope: scopeInput,
      query: "",
      filters: {
        nodeKinds: splitKinds<KnowledgeNodeKind>(nodeKindsKey),
        edgeKinds: splitKinds<KnowledgeEdgeKind>(edgeKindsKey),
        neighbor: node.source,
        neighborLimit: NEIGHBOR_LIMIT,
      },
      nodeOffset: 0,
      edgeOffset: 0,
      nodeLimit: 1,
      edgeLimit: NEIGHBOR_LIMIT,
      searchLimit: 1,
    })
      .then((response) => {
        if (cancelled || currentRequest !== requestId.current) return;
        setState({ edges: response.edges, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || currentRequest !== requestId.current) return;
        setState({
          edges: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    edgeKindsKey,
    node,
    nodeKindsKey,
    projectPath,
    scope.kind,
    scopeSpaceId,
    sourceKey,
  ]);

  return state;
}

function splitKinds<T extends string>(value: string): T[] {
  return value === "" ? [] : (value.split(",") as T[]);
}

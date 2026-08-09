import { useEffect, useMemo, useRef, useState } from "react";
import { getKnowledgeSnapshot } from "../api/knowledge-api";
import { mergeKnowledgePages } from "../model/pagination";
import type { KnowledgeScope, KnowledgeSnapshot } from "../model/types";

const COMPACT_NODE_LIMIT = 300;
const COMPACT_EDGE_LIMIT = 600;
const COMPLETE_NODE_PAGE_LIMIT = 1_000;
const COMPLETE_EDGE_PAGE_LIMIT = 2_000;
const PARTIAL_RETRY_LIMIT = 24;

export type KnowledgeLoadMode = "compact" | "complete";

export interface KnowledgeSnapshotState {
  snapshot: KnowledgeSnapshot | null;
  loading: boolean;
  error: string | null;
  mode: KnowledgeLoadMode;
  projectionKey: string;
}

export function useKnowledgeSnapshot(
  projectPath: string | null,
  scope: KnowledgeScope,
  query: string,
  mode: KnowledgeLoadMode = "compact",
): KnowledgeSnapshotState {
  const scopeKind = scope.kind;
  const scopeSpaceId = scope.kind === "space" ? scope.spaceId : null;
  const projectionKey = useMemo(
    () =>
      JSON.stringify([
        projectPath,
        scopeKind,
        scopeKind === "space" ? scopeSpaceId : null,
      ]),
    [projectPath, scopeKind, scopeSpaceId],
  );
  const normalizedQuery = query.trim();
  const [state, setState] = useState<KnowledgeSnapshotState>({
    snapshot: null,
    loading: projectPath !== null,
    error: null,
    mode,
    projectionKey,
  });
  const graphRequestId = useRef(0);
  const searchRequestId = useRef(0);

  useEffect(() => {
    const currentRequest = ++graphRequestId.current;
    ++searchRequestId.current;
    let cancelled = false;

    if (!projectPath) {
      queueMicrotask(() => {
        if (!cancelled && currentRequest === graphRequestId.current) {
          setState({
            snapshot: null,
            loading: false,
            error: null,
            mode,
            projectionKey,
          });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled && currentRequest === graphRequestId.current) {
        setState({
          snapshot: null,
          loading: true,
          error: null,
          mode,
          projectionKey,
        });
      }
    });

    const scopeInput =
      scopeKind === "project"
        ? ({ kind: "project" } as const)
        : ({ kind: "space", spaceId: scopeSpaceId } as const);

    void (async () => {
      let partialRetry = 0;

      while (!cancelled && currentRequest === graphRequestId.current) {
        let merged: KnowledgeSnapshot | null = null;
        let nodeOffset = 0;
        let edgeOffset = 0;

        do {
          const page = await getKnowledgeSnapshot({
            projectPath,
            scope: scopeInput,
            query: "",
            nodeOffset,
            edgeOffset,
            nodeLimit:
              mode === "complete"
                ? COMPLETE_NODE_PAGE_LIMIT
                : COMPACT_NODE_LIMIT,
            edgeLimit:
              mode === "complete"
                ? COMPLETE_EDGE_PAGE_LIMIT
                : COMPACT_EDGE_LIMIT,
            searchLimit: 20,
          });
          if (cancelled || currentRequest !== graphRequestId.current) return;

          merged = mergeKnowledgePages(merged, page);
          const nextSnapshot = merged;
          const hasMorePages =
            mode === "complete" && (page.hasMoreNodes || page.hasMoreEdges);
          const willRetryPartial =
            !hasMorePages &&
            partialRetry < PARTIAL_RETRY_LIMIT &&
            hasTransientPoolDiagnostic(page);
          setState((previous) => ({
            snapshot: {
              ...nextSnapshot,
              searchItems:
                previous.projectionKey === projectionKey && previous.snapshot
                  ? previous.snapshot.searchItems
                  : nextSnapshot.searchItems,
            },
            loading: hasMorePages || willRetryPartial,
            error: null,
            mode,
            projectionKey,
          }));

          if (!hasMorePages) break;

          nodeOffset = page.nextNodeOffset ?? page.totalNodeCount;
          edgeOffset = page.nextEdgeOffset ?? page.totalEdgeCount;
          await yieldToRenderer();
        } while (!cancelled && currentRequest === graphRequestId.current);

        if (
          !merged ||
          partialRetry >= PARTIAL_RETRY_LIMIT ||
          !hasTransientPoolDiagnostic(merged)
        ) {
          return;
        }

        partialRetry += 1;
        await waitForPoolRetry(partialRetry);
      }
    })().catch((error: unknown) => {
      if (cancelled || currentRequest !== graphRequestId.current) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [mode, projectPath, projectionKey, scopeKind, scopeSpaceId]);

  const graphTotalNodeCount =
    state.projectionKey === projectionKey
      ? state.snapshot?.totalNodeCount
      : undefined;
  const graphTotalEdgeCount =
    state.projectionKey === projectionKey
      ? state.snapshot?.totalEdgeCount
      : undefined;

  useEffect(() => {
    if (
      !projectPath ||
      graphTotalNodeCount === undefined ||
      graphTotalEdgeCount === undefined
    ) {
      return;
    }

    const currentRequest = ++searchRequestId.current;
    let cancelled = false;
    const scopeInput =
      scopeKind === "project"
        ? ({ kind: "project" } as const)
        : ({ kind: "space", spaceId: scopeSpaceId } as const);

    void getKnowledgeSnapshot({
      projectPath,
      scope: scopeInput,
      query: normalizedQuery,
      nodeOffset: graphTotalNodeCount,
      edgeOffset: graphTotalEdgeCount,
      nodeLimit: 1,
      edgeLimit: 1,
      searchLimit: 20,
    })
      .then((response) => {
        if (cancelled || currentRequest !== searchRequestId.current) return;
        setState((previous) => {
          if (previous.projectionKey !== projectionKey || !previous.snapshot) {
            return previous;
          }
          return {
            ...previous,
            snapshot: {
              ...previous.snapshot,
              searchItems: response.searchItems,
            },
          };
        });
      })
      .catch(() => {
        // Search refinement is best-effort and must not discard a loaded graph.
      });

    return () => {
      cancelled = true;
    };
  }, [
    graphTotalEdgeCount,
    graphTotalNodeCount,
    mode,
    normalizedQuery,
    projectPath,
    projectionKey,
    scopeKind,
    scopeSpaceId,
  ]);

  if (state.projectionKey !== projectionKey || state.mode !== mode) {
    return {
      snapshot: null,
      loading: projectPath !== null,
      error: null,
      mode,
      projectionKey,
    };
  }

  return state;
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
}

function hasTransientPoolDiagnostic(snapshot: KnowledgeSnapshot): boolean {
  return snapshot.diagnostics.some(({ code }) =>
    ["pool_reindexing", "pool_unavailable", "snapshot_unavailable"].includes(
      code,
    ),
  );
}

function waitForPoolRetry(attempt: number): Promise<void> {
  const delay = Math.min(5_000, 750 * 1.35 ** Math.min(attempt - 1, 8));
  return new Promise((resolve) => window.setTimeout(resolve, delay));
}

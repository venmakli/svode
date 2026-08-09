import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { KnowledgeCanvas } from "./knowledge-canvas";
import { knowledgeSpaceColor } from "../lib/space-color";
import type { KnowledgeSnapshotState } from "../hooks/use-knowledge-snapshot";
import type { KnowledgeSnapshot } from "../model/types";
import * as m from "@/paraglide/messages.js";

export function KnowledgeGraphView({
  state,
  selectedNodeId,
  matchedNodeIds,
  resetKey,
  onNodeSelect,
}: {
  state: KnowledgeSnapshotState;
  selectedNodeId: string | null;
  matchedNodeIds: Set<string>;
  resetKey: number;
  onNodeSelect: (nodeId: string | null) => void;
}) {
  const snapshot = state.snapshot;
  if (!snapshot && state.loading) {
    return <GraphMessage description={m.knowledge_graph_loading()} />;
  }
  if (
    !snapshot ||
    (snapshot.status === "error" && snapshot.nodes.length === 0)
  ) {
    return <GraphMessage description={m.knowledge_graph_error()} />;
  }
  if (snapshot.nodes.length === 0) {
    return <GraphMessage description={m.knowledge_graph_empty()} />;
  }

  return (
    <div className="relative size-full min-h-0 overflow-hidden">
      <KnowledgeCanvas
        nodes={snapshot.nodes}
        edges={snapshot.edges}
        totalNodeCount={snapshot.totalNodeCount}
        selectedNodeId={selectedNodeId}
        matchedNodeIds={matchedNodeIds}
        resetKey={resetKey}
        graphKey={state.projectionKey}
        loadingMore={state.mode === "complete" && state.loading}
        onNodeSelect={onNodeSelect}
      />
      <GraphLegend snapshot={snapshot} />
      <GraphStatus snapshot={snapshot} loading={state.loading} />
    </div>
  );
}

function GraphLegend({ snapshot }: { snapshot: KnowledgeSnapshot }) {
  const spaces = new Map<string, { id: string | null; name: string }>();
  for (const node of snapshot.nodes) {
    const key = node.source.spaceId ?? "root";
    if (!spaces.has(key)) {
      spaces.set(key, { id: node.source.spaceId, name: node.spaceName });
    }
  }
  const visibleSpaces = [...spaces.values()].slice(0, 4);
  const hiddenSpaceCount = Math.max(0, spaces.size - visibleSpaces.length);
  const readyLinkCount = snapshot.edges.filter(
    (edge) => edge.targetStatus === "ready" && edge.targetId,
  ).length;

  return (
    <div className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-1.5rem)] rounded-lg border bg-background/85 px-2.5 py-2 shadow-sm backdrop-blur-sm">
      <p className="text-xs font-medium">
        {m.knowledge_graph_summary({
          nodes: snapshot.nodes.length,
          edges: readyLinkCount,
        })}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
        {visibleSpaces.map((space) => (
          <span
            key={space.id ?? "root"}
            className="inline-flex items-center gap-1"
          >
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: knowledgeSpaceColor(space.id) }}
            />
            <span className="max-w-28 truncate">{space.name}</span>
          </span>
        ))}
        {hiddenSpaceCount > 0 && <span>+{hiddenSpaceCount}</span>}
      </div>
    </div>
  );
}

function GraphStatus({
  snapshot,
  loading,
}: {
  snapshot: KnowledgeSnapshot;
  loading: boolean;
}) {
  const partial = snapshot.status === "partial";
  if (!partial && !snapshot.truncated && !loading) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-1.5">
      {loading && (
        <Badge variant="secondary">
          {partial && !snapshot.hasMoreNodes && !snapshot.hasMoreEdges
            ? m.knowledge_graph_waiting_for_spaces()
            : snapshot.totalNodeCount > 0
              ? m.knowledge_graph_loading_progress({
                  nodes: snapshot.nodes.length,
                  totalNodes: snapshot.totalNodeCount,
                  edges: snapshot.edges.length,
                  totalEdges: snapshot.totalEdgeCount,
                })
              : m.knowledge_graph_loading()}
        </Badge>
      )}
      {partial && (
        <Badge variant="secondary">
          {m.knowledge_graph_partial({
            ready: snapshot.readablePools,
            total: snapshot.totalPools,
          })}
        </Badge>
      )}
      {snapshot.truncated && !loading && (
        <Badge variant="outline">
          {m.knowledge_graph_truncated({
            nodes: snapshot.omittedNodeCount,
            edges: snapshot.omittedEdgeCount,
          })}
        </Badge>
      )}
    </div>
  );
}

function GraphMessage({ description }: { description: string }) {
  return (
    <Empty className="size-full border-0">
      <EmptyHeader>
        <EmptyTitle>{m.knowledge_graph_title()}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

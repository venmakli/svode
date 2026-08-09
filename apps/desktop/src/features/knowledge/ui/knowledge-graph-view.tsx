import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { KnowledgeCanvas } from "./knowledge-canvas";
import { KnowledgeStatus } from "./knowledge-status";
import {
  knowledgeSpaceColorKey,
  knowledgeSpaceColorMap,
} from "../lib/space-color";
import type { KnowledgeSnapshotState } from "../hooks/use-knowledge-snapshot";
import type { KnowledgeSnapshot } from "../model/types";
import * as m from "@/paraglide/messages.js";

export function KnowledgeGraphView({
  state,
  selectedNodeId,
  focusedNodeId,
  matchedNodeIds,
  resetKey,
  onNodeSelect,
}: {
  state: KnowledgeSnapshotState;
  selectedNodeId: string | null;
  focusedNodeId?: string | null;
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
    return (
      <GraphMessage
        description={m.knowledge_graph_error()}
        onRetry={state.retry}
      />
    );
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
        focusedNodeId={focusedNodeId ?? null}
        matchedNodeIds={matchedNodeIds}
        resetKey={resetKey}
        graphKey={state.projectionKey}
        loadingMore={state.mode === "complete" && state.loading}
        onNodeSelect={onNodeSelect}
      />
      <GraphLegend snapshot={snapshot} />
      <KnowledgeStatus state={state} />
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
  const spaceColors = knowledgeSpaceColorMap(
    snapshot.nodes.map((node) => node.source.spaceId),
  );
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
              style={{
                backgroundColor: spaceColors.get(
                  knowledgeSpaceColorKey(space.id),
                ),
              }}
            />
            <span className="max-w-28 truncate">{space.name}</span>
          </span>
        ))}
        {hiddenSpaceCount > 0 && <span>+{hiddenSpaceCount}</span>}
      </div>
    </div>
  );
}

function GraphMessage({
  description,
  onRetry,
}: {
  description: string;
  onRetry?: () => void;
}) {
  return (
    <Empty className="size-full border-0">
      <EmptyHeader>
        <EmptyTitle>{m.knowledge_graph_title()}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {onRetry && (
        <Button type="button" variant="outline" onClick={onRetry}>
          <RefreshCw data-icon="inline-start" />
          {m.knowledge_graph_retry()}
        </Button>
      )}
    </Empty>
  );
}

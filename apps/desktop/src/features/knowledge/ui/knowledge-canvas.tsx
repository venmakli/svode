import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { KnowledgeEdge, KnowledgeNode } from "../model/types";

const KnowledgeGraphCanvas = lazy(() =>
  import("./knowledge-graph-canvas").then((module) => ({
    default: module.KnowledgeGraphCanvas,
  })),
);

export function KnowledgeCanvas({
  nodes,
  edges,
  totalNodeCount,
  selectedNodeId,
  matchedNodeIds,
  resetKey,
  graphKey,
  loadingMore,
  onNodeSelect,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  totalNodeCount: number;
  selectedNodeId: string | null;
  matchedNodeIds: Set<string>;
  resetKey: number;
  graphKey: string;
  loadingMore: boolean;
  onNodeSelect: (nodeId: string | null) => void;
}) {
  return (
    <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
      <KnowledgeGraphCanvas
        key={graphKey}
        nodes={nodes}
        edges={edges}
        totalNodeCount={totalNodeCount}
        selectedNodeId={selectedNodeId}
        matchedNodeIds={matchedNodeIds}
        resetKey={resetKey}
        loadingMore={loadingMore}
        onNodeSelect={onNodeSelect}
      />
    </Suspense>
  );
}

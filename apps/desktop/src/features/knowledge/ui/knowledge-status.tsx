import {
  CircleAlert,
  CircleCheck,
  Clock3,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";
import type { KnowledgeSnapshotState } from "../hooks/use-knowledge-snapshot";
import * as m from "@/paraglide/messages.js";

type ReadStatus = "fresh" | "checking" | "partial" | "stale";

export function KnowledgeStatus({
  state,
  placement = "overlay",
}: {
  state: KnowledgeSnapshotState;
  placement?: "overlay" | "inline";
}) {
  const snapshot = state.snapshot;
  if (!snapshot) return null;

  const status = readStatus(state);
  const label = statusLabel(status);

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        placement === "overlay"
          ? "absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)]"
          : "min-w-0 flex-wrap",
      )}
    >
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {statusIcon(status)}
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80">
          <PopoverHeader>
            <PopoverTitle>{label}</PopoverTitle>
            <PopoverDescription>{statusDescription(status)}</PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {m.knowledge_graph_partial({
                ready: snapshot.readablePools,
                total: snapshot.totalPools,
              })}
            </Badge>
            <Badge variant="outline">
              {m.knowledge_graph_status_counts({
                nodes: snapshot.totalNodeCount,
                edges: snapshot.totalEdgeCount,
              })}
            </Badge>
            {snapshot.truncated && (
              <Badge variant="outline">
                {m.knowledge_graph_truncated({
                  nodes: snapshot.omittedNodeCount,
                  edges: snapshot.omittedEdgeCount,
                })}
              </Badge>
            )}
          </div>
          {snapshot.freshness.length > 0 && (
            <div className="max-h-32 space-y-1 overflow-y-auto border-t pt-2.5 text-xs">
              {snapshot.freshness.map((pool) => (
                <div
                  key={pool.spaceId ?? "root"}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="truncate text-muted-foreground">
                    {pool.spaceId ?? m.knowledge_graph_root_space()}
                  </span>
                  <span className="shrink-0">
                    {pool.stale
                      ? m.knowledge_graph_status_stale()
                      : formatCheckedAt(pool.checkedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {snapshot.diagnostics.length > 0 && (
            <div className="max-h-40 space-y-2 overflow-y-auto border-t pt-2.5">
              {snapshot.diagnostics.map((diagnostic, index) => (
                <div
                  key={`${diagnostic.spaceId ?? "root"}:${diagnostic.code}:${index}`}
                  className="flex gap-2 text-xs"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="font-medium">{diagnostic.code}</p>
                    <p className="break-words text-muted-foreground">
                      {diagnostic.message}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(state.error || status === "stale") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={state.retry}
            >
              <RefreshCw data-icon="inline-start" />
              {m.knowledge_graph_retry()}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={state.repairing}
            onClick={() => void state.repair()}
          >
            {state.repairing ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <RotateCcw data-icon="inline-start" />
            )}
            {state.repairing
              ? m.knowledge_graph_rebuilding()
              : m.knowledge_graph_rebuild()}
          </Button>
          {state.repairError && (
            <p className="break-words text-xs text-destructive">
              {m.knowledge_graph_rebuild_error()}
            </p>
          )}
        </PopoverContent>
      </Popover>
      {placement === "inline" && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {m.knowledge_graph_status_counts({
            nodes: snapshot.totalNodeCount,
            edges: snapshot.totalEdgeCount,
          })}
        </span>
      )}
      {snapshot.truncated && (
        <Badge variant="outline">
          {m.knowledge_graph_truncated({
            nodes: snapshot.omittedNodeCount,
            edges: snapshot.omittedEdgeCount,
          })}
        </Badge>
      )}
      {state.loading && snapshot.totalNodeCount > snapshot.nodes.length && (
        <Badge variant="secondary">
          {m.knowledge_graph_loading_progress({
            nodes: snapshot.nodes.length,
            totalNodes: snapshot.totalNodeCount,
            edges: snapshot.edges.length,
            totalEdges: snapshot.totalEdgeCount,
          })}
        </Badge>
      )}
    </div>
  );
}

function readStatus(state: KnowledgeSnapshotState): ReadStatus {
  if (state.error || state.repairError) return "stale";
  if (state.loading || state.repairing) return "checking";
  if (state.snapshot?.status === "stale") return "stale";
  if (state.snapshot?.status === "partial") return "partial";
  return "fresh";
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function statusIcon(status: ReadStatus) {
  switch (status) {
    case "fresh":
      return <CircleCheck data-icon="inline-start" />;
    case "checking":
      return <Clock3 data-icon="inline-start" />;
    case "partial":
      return <CircleAlert data-icon="inline-start" />;
    case "stale":
      return <TriangleAlert data-icon="inline-start" />;
  }
}

function statusLabel(status: ReadStatus) {
  switch (status) {
    case "fresh":
      return m.knowledge_graph_status_fresh();
    case "checking":
      return m.knowledge_graph_status_checking();
    case "partial":
      return m.knowledge_graph_status_partial();
    case "stale":
      return m.knowledge_graph_status_stale();
  }
}

function statusDescription(status: ReadStatus) {
  switch (status) {
    case "fresh":
      return m.knowledge_graph_status_fresh_description();
    case "checking":
      return m.knowledge_graph_status_checking_description();
    case "partial":
      return m.knowledge_graph_status_partial_description();
    case "stale":
      return m.knowledge_graph_status_stale_description();
  }
}

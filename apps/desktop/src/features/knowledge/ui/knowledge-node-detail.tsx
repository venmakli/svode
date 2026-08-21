import { ArrowLeft, ArrowUpRight, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { KnowledgeNeighbor } from "../model/projection";
import type { KnowledgeNode } from "../model/types";
import {
  KnowledgeKindIcon,
  knowledgeEdgeKindLabel,
  knowledgeNodeKindLabel,
} from "./knowledge-kind";
import * as m from "@/paraglide/messages.js";

export function KnowledgeNodeDetail({
  node,
  neighbors,
  neighborsLoading = false,
  neighborsError = null,
  onBack,
  onSelectNode,
  onOpenSource,
}: {
  node: KnowledgeNode | null;
  neighbors: KnowledgeNeighbor[];
  neighborsLoading?: boolean;
  neighborsError?: string | null;
  onBack?: () => void;
  onSelectNode: (nodeId: string) => void;
  onOpenSource: (node: KnowledgeNode) => void | Promise<void>;
}) {
  if (!node) {
    return (
      <div className="flex size-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {m.knowledge_graph_select_prompt()}
      </div>
    );
  }
  return (
    <ScrollArea className="size-full min-w-0 overflow-hidden">
      <div
        className="flex w-full min-w-0 max-w-full flex-col gap-4 overflow-hidden p-4"
        data-knowledge-node-detail
      >
        {onBack && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 max-w-full self-start"
            onClick={onBack}
          >
            <ArrowLeft data-icon="inline-start" />
            <span className="truncate">
              {m.knowledge_graph_back_to_results()}
            </span>
          </Button>
        )}
        <div className="flex min-w-0 max-w-full items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <KnowledgeKindIcon kind={node.source.kind} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-medium">
              {node.title || node.source.path}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {node.spaceName} · {node.source.path}
            </p>
            <Badge variant="outline" className="mt-2">
              {knowledgeNodeKindLabel(node.source.kind)}
            </Badge>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full min-w-0 max-w-full overflow-hidden"
          data-knowledge-open-source
          onClick={() => onOpenSource(node)}
        >
          <span className="min-w-0 truncate">
            {m.knowledge_graph_open_source()}
          </span>
          <ArrowUpRight data-icon="inline-end" />
        </Button>
        <dl className="grid w-full min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 overflow-hidden text-xs">
          <dt className="text-muted-foreground">
            {m.knowledge_graph_source()}
          </dt>
          <dd className="truncate">{node.canonicalSourcePath}</dd>
          {provenanceList(node.provenance, "availability").length > 0 && (
            <>
              <dt className="text-muted-foreground">
                {m.knowledge_graph_availability()}
              </dt>
              <dd className="truncate">
                {provenanceList(node.provenance, "availability").join(", ")}
              </dd>
            </>
          )}
          {provenanceList(node.provenance, "aliases").length > 0 && (
            <>
              <dt className="text-muted-foreground">
                {m.knowledge_graph_aliases()}
              </dt>
              <dd className="truncate">
                {provenanceList(node.provenance, "aliases").join(", ")}
              </dd>
            </>
          )}
        </dl>
        <Separator />
        <section className="flex min-w-0 max-w-full flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {m.knowledge_graph_connections()}
          </h3>
          {neighborsLoading && neighbors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {m.knowledge_graph_connections_loading()}
            </p>
          ) : neighbors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {m.knowledge_graph_no_connections()}
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              {neighbors.map((neighbor) => (
                <Button
                  key={neighbor.key}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full min-w-0 max-w-full justify-start overflow-hidden px-2 py-2"
                  data-knowledge-neighbor
                  disabled={!neighbor.node}
                  onClick={() =>
                    neighbor.node && onSelectNode(neighbor.node.id)
                  }
                >
                  {neighbor.source ? (
                    <KnowledgeKindIcon
                      kind={neighbor.source.kind}
                      data-icon="inline-start"
                    />
                  ) : (
                    <Unlink data-icon="inline-start" />
                  )}
                  <span className="min-w-0 flex-1 overflow-hidden text-left">
                    <span className="block truncate">{neighbor.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {neighbor.edgeKinds
                        .map(knowledgeEdgeKindLabel)
                        .join(" · ")}
                      {neighbor.fieldNames.length > 0 &&
                        ` · ${neighbor.fieldNames.join(", ")}`}
                      {neighbor.targetStatus === "broken" &&
                        ` · ${m.knowledge_graph_broken_target()}`}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          )}
          {neighborsError && (
            <p className="text-xs text-muted-foreground">
              {m.knowledge_graph_connections_unavailable()}
            </p>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function provenanceList(
  provenance: Record<string, unknown>,
  key: string,
): string[] {
  const value = provenance[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

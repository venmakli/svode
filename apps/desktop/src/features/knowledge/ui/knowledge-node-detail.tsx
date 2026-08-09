import { ArrowUpRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { KnowledgeNode } from "../model/types";
import * as m from "@/paraglide/messages.js";

export function KnowledgeNodeDetail({
  node,
  neighbors,
  onSelectNode,
  onOpenSource,
}: {
  node: KnowledgeNode | null;
  neighbors: KnowledgeNode[];
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
    <ScrollArea className="size-full">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <FileText />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-medium">
              {node.title || node.source.path}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {node.spaceName} · {node.source.path}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenSource(node)}
        >
          {m.knowledge_graph_open_source()}
          <ArrowUpRight data-icon="inline-end" />
        </Button>
        <Separator />
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {m.knowledge_graph_connections()}
          </h3>
          {neighbors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {m.knowledge_graph_no_connections()}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {neighbors.map((neighbor) => (
                <Button
                  key={neighbor.id}
                  type="button"
                  variant="ghost"
                  className="h-auto justify-start px-2 py-2"
                  onClick={() => onSelectNode(neighbor.id)}
                >
                  <FileText data-icon="inline-start" />
                  <span className="min-w-0 truncate">
                    {neighbor.title || neighbor.source.path}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

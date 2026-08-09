import { Badge } from "@/components/ui/badge";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { KnowledgeSearchItem } from "../model/types";
import { KnowledgeKindIcon, knowledgeNodeKindLabel } from "./knowledge-kind";
import * as m from "@/paraglide/messages.js";

export function KnowledgeCommandResults({
  items,
  loading,
  emptyMessage,
  heading,
  onOpen,
}: {
  items: KnowledgeSearchItem[];
  loading: boolean;
  emptyMessage?: string;
  heading?: string;
  onOpen: (item: KnowledgeSearchItem) => void | Promise<void>;
}) {
  if (items.length === 0) {
    if (loading) return null;
    return <CommandEmpty>{emptyMessage ?? m.search_no_results()}</CommandEmpty>;
  }

  return (
    <CommandGroup heading={heading ?? m.knowledge_graph_results()}>
      {items.map((item) => (
        <CommandItem
          key={item.nodeId}
          value={item.nodeId}
          className="items-start py-2.5"
          onSelect={() => onOpen(item)}
        >
          <KnowledgeKindIcon kind={item.source.kind} />
          <ResultContent item={item} />
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function KnowledgeResultList({
  items,
  loading,
  onFocus,
  onSelect,
}: {
  items: KnowledgeSearchItem[];
  loading: boolean;
  onFocus: (nodeId: string | null) => void;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <ScrollArea className="size-full">
      <div className="flex flex-col gap-1 p-2">
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
          {m.knowledge_graph_results()}
        </p>
        {items.length === 0 && !loading && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {m.search_no_results()}
          </p>
        )}
        {items.map((item) => (
          <Button
            key={item.nodeId}
            type="button"
            variant="ghost"
            className="h-auto items-start justify-start px-2 py-2.5"
            onPointerEnter={() => onFocus(item.nodeId)}
            onPointerLeave={() => onFocus(null)}
            onFocus={() => onFocus(item.nodeId)}
            onBlur={() => onFocus(null)}
            onClick={() => onSelect(item.nodeId)}
          >
            <KnowledgeKindIcon
              kind={item.source.kind}
              data-icon="inline-start"
            />
            <ResultContent item={item} />
          </Button>
        ))}
      </div>
    </ScrollArea>
  );
}

function ResultContent({ item }: { item: KnowledgeSearchItem }) {
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium">
          {item.title || item.source.path}
        </span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {knowledgeNodeKindLabel(item.source.kind)}
        </Badge>
      </span>
      <span className="block truncate text-xs text-muted-foreground">
        {item.spaceName} · {item.source.path}
      </span>
      {item.snippet && (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {item.snippet}
        </span>
      )}
    </span>
  );
}

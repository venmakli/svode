import type { CSSProperties, MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, Database, FileText, Folder, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { isFolderEntry, isNestedCollectionEntry } from "./utils";
import { BoardPropertyFlow } from "./board-property-flow";
import type { BoardCardProps } from "./types";
import * as m from "@/paraglide/messages.js";

export function SortableBoardCard(props: BoardCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.card.entry.path,
    data: {
      type: "card",
      entryPath: props.card.entry.path,
      groupKey: props.card.groupKey,
    },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && "opacity-45")}
      {...attributes}
      {...listeners}
    >
      <BoardCardContent {...props} active={props.active || isDragging} />
    </div>
  );
}

export function BoardCardContent({
  card,
  cardFields,
  customColumns,
  nestedCollectionPaths,
  active,
  overlay,
  spacePath,
  projectPath,
  persons,
  onRequestPersons,
  onUpdateField,
  onOpen,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onDuplicate,
  onDelete,
}: BoardCardProps) {
  const { entry } = card;
  const showIcon = cardFields.includes("icon");
  const showDescription = cardFields.includes("description");
  const nestedCollection = isNestedCollectionEntry(
    entry,
    nestedCollectionPaths,
  );
  const folder = isFolderEntry(entry);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          size="sm"
          className={cn(
            "group/board-card cursor-pointer gap-2 rounded-lg py-2 shadow-none ring-1 ring-foreground/10 transition-[box-shadow,transform]",
            "hover:-translate-y-px hover:ring-foreground/15 hover:shadow-sm active:cursor-grabbing",
            active && "cursor-grabbing shadow-md ring-primary/30",
            overlay && "w-[264px] cursor-grabbing opacity-95",
          )}
          onClick={(event) => {
            if (shouldIgnoreCardOpen(event)) return;
            if (nestedCollection) onOpenNestedPeek(entry);
            else onOpen(entry);
          }}
          onDoubleClick={(event) => {
            if (shouldIgnoreCardOpen(event)) return;
            onOpenFullPage(entry);
          }}
        >
          <CardContent className="flex flex-col gap-2 px-2.5">
            <div className="flex min-w-0 items-start gap-1.5">
              {showIcon ? (
                <span className="mt-px shrink-0 text-sm leading-5">
                  {entry.meta.icon || "·"}
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] font-medium leading-snug">
                  {entry.meta.title}
                </div>
                {showDescription && entry.meta.description ? (
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {entry.meta.description}
                  </div>
                ) : null}
              </div>
              <EntryKindMarker
                folder={folder}
                nestedCollection={nestedCollection}
                onOpenNested={() => onOpenNestedCollection(entry)}
              />
            </div>
            <BoardPropertyFlow
              entry={entry}
              columns={customColumns}
              persons={persons}
              relationContext={{
                spacePath,
                projectPath,
                currentFilePath: entry.path,
              }}
              onRequestPersons={onRequestPersons}
              onUpdateField={overlay ? undefined : onUpdateField}
            />
          </CardContent>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          onClick={() => {
            if (nestedCollection) onOpenNestedPeek(entry);
            else onOpen(entry);
          }}
        >
          <FileText data-icon="inline-start" />
          {m.collection_open_in_peek()}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDuplicate(entry)}>
          <Copy data-icon="inline-start" />
          {m.collection_duplicate_entry()}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={() => onDelete(entry)}>
          <Trash2 data-icon="inline-start" />
          {m.space_delete()}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EntryKindMarker({
  folder,
  nestedCollection,
  onOpenNested,
}: {
  folder: boolean;
  nestedCollection: boolean;
  onOpenNested: () => void;
}) {
  if (nestedCollection) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-board-interactive
        className="shrink-0 text-muted-foreground"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenNested();
        }}
      >
        <Database />
        <span className="sr-only">{m.table_open_nested_collection()}</span>
      </Button>
    );
  }
  if (!folder) return null;
  return (
    <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>
      <Folder style={{ width: 14, height: 14 } as CSSProperties} />
    </span>
  );
}

function shouldIgnoreCardOpen(event: MouseEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  const interactive = target.closest(
    [
      "button",
      "a",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='checkbox']",
      "[data-board-interactive]",
      "[data-radix-collection-item]",
    ].join(","),
  );
  return Boolean(
    interactive &&
    interactive !== event.currentTarget &&
    event.currentTarget.contains(interactive),
  );
}

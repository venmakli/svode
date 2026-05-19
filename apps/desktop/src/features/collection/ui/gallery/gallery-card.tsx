import type { HTMLAttributes, MouseEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, Database, FileText, Folder, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { CardPropertyFlow } from "../card-property-flow";
import { GalleryCover } from "./gallery-cover";
import type { GalleryCardProps } from "./types";
import * as m from "@/paraglide/messages.js";

export function SortableGalleryCard(props: GalleryCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.entry.path,
    disabled: props.disabledReorder,
    data: {
      type: "gallery-card",
      entryPath: props.entry.path,
    },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn("h-full", isDragging && "opacity-45")}
    >
      <GalleryCardContent
        {...props}
        dragAttributes={attributes as HTMLAttributes<HTMLDivElement>}
        dragListeners={listeners as HTMLAttributes<HTMLDivElement> | undefined}
      />
    </div>
  );
}

function GalleryCardContent({
  entry,
  schema,
  cardCover,
  cardFields,
  metaColumns,
  coverFit,
  coverAspect,
  spacePath,
  persons,
  nestedCollection,
  folder,
  disabledReorder,
  focused,
  dragAttributes,
  dragListeners,
  cardRef,
  onRequestPersons,
  onUpdateField,
  onOpen,
  onOpenFullPage,
  onOpenNestedCollection,
  onDuplicate,
  onDelete,
  onFocusCard,
  onKeyboardMove,
}: GalleryCardProps & {
  dragAttributes: HTMLAttributes<HTMLDivElement>;
  dragListeners?: HTMLAttributes<HTMLDivElement>;
}) {
  const showTitle = cardFields.includes("title");
  const showIcon = cardFields.includes("icon");
  const showDescription = cardFields.includes("description");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          ref={cardRef}
          tabIndex={0}
          data-gallery-card-path={entry.path}
          className={cn(
            "group/gallery-card relative h-full gap-0 overflow-hidden rounded-lg bg-card py-0 shadow-none ring-1 ring-foreground/10 outline-none transition-[box-shadow,transform,background]",
            "hover:-translate-y-px hover:shadow-sm hover:ring-foreground/15 focus-visible:ring-2 focus-visible:ring-ring/40",
            "cursor-pointer",
            !disabledReorder && "active:cursor-grabbing",
            focused && "ring-2 ring-ring/50",
          )}
          onFocus={() => onFocusCard(entry.path)}
          onClick={(event) => {
            if (shouldIgnoreCardOpen(event)) return;
            onOpen(entry, nestedCollection);
          }}
          onDoubleClick={(event) => {
            if (shouldIgnoreCardOpen(event)) return;
            onOpenFullPage(entry);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onKeyboardMove(entry.path, "left");
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              onKeyboardMove(entry.path, "right");
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              onKeyboardMove(entry.path, "up");
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              onKeyboardMove(entry.path, "down");
            } else if (event.key === "Enter") {
              event.preventDefault();
              onOpen(entry, nestedCollection);
            } else if (event.key === "Escape") {
              event.currentTarget.blur();
            }
          }}
          {...(!disabledReorder ? dragAttributes : {})}
          {...(!disabledReorder ? dragListeners : {})}
        >
          <EntryKindMarker
            folder={folder}
            nestedCollection={nestedCollection}
            onOpenNested={() => onOpenNestedCollection(entry)}
          />
          <GalleryCover
            entry={entry}
            cardCover={cardCover}
            coverFit={coverFit}
            coverAspect={coverAspect}
            schema={schema}
            spacePath={spacePath}
          />
          <CardContent className="flex flex-1 flex-col gap-1.5 px-2.5 py-2.5">
            {showTitle ? (
              <div className="flex min-w-0 items-start gap-1.5">
                {showIcon ? (
                  <span className="mt-px shrink-0 text-sm leading-5">
                    {entry.meta.icon || "·"}
                  </span>
                ) : null}
                <div className="line-clamp-2 min-w-0 text-[13px] font-medium leading-snug">
                  {entry.meta.title}
                </div>
              </div>
            ) : showIcon ? (
              <div className="truncate text-sm leading-5">
                {entry.meta.icon || "·"}
              </div>
            ) : null}
            {showDescription && entry.meta.description ? (
              <div className="truncate text-[12px] text-muted-foreground">
                {entry.meta.description}
              </div>
            ) : null}
            <CardPropertyFlow
              entry={entry}
              columns={metaColumns}
              persons={persons}
              className="gap-x-1.5 gap-y-1 pt-0.5"
              onRequestPersons={onRequestPersons}
              onUpdateField={onUpdateField}
            />
          </CardContent>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => onOpen(entry, nestedCollection)}>
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
        variant="secondary"
        size="icon-xs"
        data-gallery-interactive
        className="absolute right-2 top-2 z-10 shadow-sm"
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
    <span
      className="absolute right-2 top-2 z-10 grid size-6 place-items-center rounded-md bg-background/80 text-muted-foreground shadow-sm backdrop-blur"
      aria-hidden
    >
      <Folder />
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
      "[data-card-interactive]",
      "[data-gallery-interactive]",
      "[data-radix-collection-item]",
    ].join(","),
  );
  return Boolean(
    interactive &&
    interactive !== event.currentTarget &&
    event.currentTarget.contains(interactive),
  );
}

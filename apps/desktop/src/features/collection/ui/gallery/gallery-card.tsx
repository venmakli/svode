import type { HTMLAttributes } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, Database, FileText, Folder, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenuGroup,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { cn } from "@/shared/lib/utils";
import { CardPropertyFlow } from "../card-property-flow";
import { EntryTitleIcon } from "../entry-title-icon";
import { CollectionPresentationGalleryCard } from "../presentation-gallery-card";
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
  cover,
  cardFields,
  metaColumns,
  coverFit,
  coverAspect,
  spacePath,
  projectPath,
  actors,
  nestedCollection,
  folder,
  disabledReorder,
  focused,
  dragAttributes,
  dragListeners,
  cardRef,
  onRequestActors,
  onUpdateField,
  onOpen,
  onOpenFullPage,
  onOpenNestedCollection,
  onOpenPath,
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
    <CollectionPresentationGalleryCard
      {...(!disabledReorder ? dragAttributes : {})}
      {...(!disabledReorder ? dragListeners : {})}
      cardRef={cardRef}
      tabIndex={0}
      data-gallery-card-path={entry.path}
      density="compact"
      selected={focused}
      className={cn(!disabledReorder && "active:cursor-grabbing")}
      cover={
        <GalleryCover
          cover={cover}
          coverFit={coverFit}
          coverAspect={coverAspect}
        />
      }
      overlays={
        <EntryKindMarker
          folder={folder}
          nestedCollection={nestedCollection}
          onOpenNested={() => onOpenNestedCollection(entry)}
        />
      }
      leading={
        showIcon ? (
          <EntryTitleIcon
            icon={entry.meta.icon}
            className="h-5 min-w-4 text-sm leading-5"
          />
        ) : undefined
      }
      title={showTitle ? entry.meta.title : undefined}
      description={
        showDescription && entry.meta.description
          ? entry.meta.description
          : undefined
      }
      properties={
        <CardPropertyFlow
          entry={entry}
          columns={metaColumns}
          actors={actors}
          relationContext={{
            spacePath,
            projectPath,
            currentFilePath: entry.path,
            onOpenPath,
          }}
          className="gap-x-1.5 gap-y-1 pt-0.5"
          onRequestActors={onRequestActors}
          onUpdateField={onUpdateField}
        />
      }
      contextMenu={
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onOpen(entry, nestedCollection)}>
            <FileText data-icon="inline-start" />
            {m.collection_open_in_peek()}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onDuplicate(entry)}>
            <Copy data-icon="inline-start" />
            {m.collection_duplicate_entry()}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => onDelete(entry)}
          >
            <Trash2 data-icon="inline-start" />
            {m.space_delete()}
          </ContextMenuItem>
        </ContextMenuGroup>
      }
      contextMenuClassName="w-48"
      onFocusCard={() => onFocusCard(entry.path)}
      onMoveFocus={(key) => onKeyboardMove(entry.path, key)}
      onOpen={() => onOpen(entry, nestedCollection)}
      onDoubleOpen={() => onOpenFullPage(entry)}
    />
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

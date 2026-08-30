import type { ButtonHTMLAttributes } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FileText,
  GripVertical,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenuGroup,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { cn } from "@/shared/lib/utils";
import { documentNameConflictDisplayPath } from "@/features/entry/entry-api";
import { CardPropertyFlow } from "../card-property-flow";
import { EntryTitleIcon } from "../entry-title-icon";
import { CollectionPresentationListRow } from "../presentation-core";
import type { ListRowProps } from "./types";
import * as m from "@/paraglide/messages.js";

export function SortableListRow(props: ListRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.row.entry.path,
    disabled: props.disabledReorder,
    data: {
      type: "list-row",
      entryPath: props.row.entry.path,
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
    >
      <CollectionListRowContent
        {...props}
        dragAttributes={attributes as ButtonHTMLAttributes<HTMLButtonElement>}
        dragListeners={
          listeners as ButtonHTMLAttributes<HTMLButtonElement> | undefined
        }
      />
    </div>
  );
}

export function CollectionListRowContent({
  row,
  density,
  cardFields,
  metaColumns,
  spacePath,
  projectPath,
  actors,
  disabledReorder,
  focused,
  dragAttributes,
  dragListeners,
  onRequestActors,
  onUpdateField,
  onToggle,
  onOpen,
  onOpenFullPage,
  onOpenNestedCollection,
  onOpenPath,
  onDuplicate,
  onDelete,
  onFocusRow,
  onKeyboardMove,
  readOnly = false,
  rowRef,
}: ListRowProps & {
  dragAttributes: ButtonHTMLAttributes<HTMLButtonElement>;
  dragListeners?: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const { entry } = row;
  const conflictPath = documentNameConflictDisplayPath(entry);
  const showIcon = cardFields.includes("icon");
  const showDescription =
    density === "comfortable" && cardFields.includes("description");

  return (
    <CollectionPresentationListRow
      rowRef={rowRef}
      tabIndex={0}
      data-list-row-path={entry.path}
      density={density}
      selected={focused}
      style={{ paddingLeft: `${12 + row.level * 18}px` }}
      onFocusRow={() => onFocusRow(entry.path)}
      onOpen={() => onOpen(entry, row.nestedCollection)}
      onDoubleOpen={() => onOpenFullPage(entry)}
      onMoveFocus={(key) => {
        if (key === "ArrowUp") onKeyboardMove(entry.path, -1);
        if (key === "ArrowDown") onKeyboardMove(entry.path, 1);
      }}
      leading={
        <button
          type="button"
          className={cn(
            "flex h-[22px] w-3.5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity [&_svg]:size-3.5",
            disabledReorder
              ? "cursor-default group-hover/list-row:opacity-35"
              : "cursor-grab group-hover/list-row:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          )}
          aria-disabled={disabledReorder}
          onClick={(event) => event.stopPropagation()}
          {...dragAttributes}
          {...dragListeners}
        >
          <GripVertical />
          <span className="sr-only">{m.view_query_sort_notice()}</span>
        </button>
      }
      identity={
        <div className="flex min-w-0 items-center gap-1.5">
          {row.expandable ? (
            <button
              type="button"
              data-list-interactive
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(entry);
              }}
            >
              {row.expanded ? <ChevronDown /> : <ChevronRight />}
            </button>
          ) : null}
          {showIcon ? (
            <EntryTitleIcon
              icon={entry.meta.icon}
              className="size-5 text-[15px] leading-none"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">
                {entry.meta.title}
              </span>
              {row.nestedCollection ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-list-interactive
                  className="shrink-0 text-muted-foreground"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenNestedCollection(entry);
                  }}
                >
                  <Database />
                  <span className="sr-only">
                    {m.table_open_nested_collection()}
                  </span>
                </Button>
              ) : null}
            </div>
            {conflictPath ? (
              <div
                data-entry-name-conflict-path
                className="truncate text-xs text-muted-foreground"
              >
                {conflictPath}
              </div>
            ) : null}
            {showDescription && entry.meta.description ? (
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {entry.meta.description}
              </div>
            ) : null}
          </div>
        </div>
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
          mode="inline"
          className="max-w-[46vw] justify-end gap-x-2 gap-y-0.5 overflow-hidden"
          onRequestActors={onRequestActors}
          onUpdateField={onUpdateField}
        />
      }
      contextMenu={
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onOpen(entry, row.nestedCollection)}>
            <FileText data-icon="inline-start" />
            {m.collection_open_in_peek()}
          </ContextMenuItem>
          {!readOnly ? (
            <ContextMenuItem onClick={() => onDuplicate(entry)}>
              <Copy data-icon="inline-start" />
              {m.collection_duplicate_entry()}
            </ContextMenuItem>
          ) : null}
          {!readOnly ? (
            <ContextMenuItem
              variant="destructive"
              onClick={() => onDelete(entry)}
            >
              <Trash2 data-icon="inline-start" />
              {m.space_delete()}
            </ContextMenuItem>
          ) : null}
        </ContextMenuGroup>
      }
    />
  );
}

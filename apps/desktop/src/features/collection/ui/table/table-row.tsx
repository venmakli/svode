import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, FileText, GripVertical, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TableCell, TableRow as ShadcnTableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { CollectionTableRow } from "./types";
import * as m from "@/paraglide/messages.js";

export function SortableTableRow({
  row,
  disabled,
  focused,
  rowHeightClassName,
  children,
  onFocus,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  row: CollectionTableRow;
  disabled: boolean;
  focused: boolean;
  rowHeightClassName: string;
  children: ReactNode;
  onFocus: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const sortable = useSortable({ id: row.entry.path, disabled });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ShadcnTableRow
          ref={sortable.setNodeRef}
          data-table-row-path={row.entry.path}
          className={cn(
            "group/row h-9 bg-background text-[13px] hover:bg-muted/40",
            rowHeightClassName,
            focused && "bg-accent/60",
            sortable.isDragging && "opacity-60",
          )}
          style={{
            transform: CSS.Transform.toString(sortable.transform),
            transition: sortable.transition,
          }}
          tabIndex={0}
          onFocus={onFocus}
          onClick={(event) => {
            if (shouldIgnoreRowOpen(event.target)) return;
            onOpen();
          }}
          onDoubleClick={onOpen}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              onOpen();
            }
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              event.stopPropagation();
              onDelete();
            }
          }}
        >
          <TableCell className="w-[18px] p-0 text-muted-foreground">
            <div className="flex items-center justify-center">
              {row.child ? null : (
                <button
                  type="button"
                  className={cn(
                    "flex h-[22px] w-3.5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity [&_svg]:size-3.5",
                    disabled
                      ? "cursor-default group-hover/row:opacity-35"
                      : "cursor-grab group-hover/row:opacity-100 hover:bg-accent focus-visible:opacity-100 active:cursor-grabbing",
                  )}
                  {...sortable.attributes}
                  {...sortable.listeners}
                >
                  <GripVertical />
                </button>
              )}
            </div>
          </TableCell>
          {children}
        </ShadcnTableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onOpen}>
          <FileText data-icon="inline-start" />
          {m.collection_open_in_peek()}
        </ContextMenuItem>
        <ContextMenuItem onClick={onDuplicate}>
          <Copy data-icon="inline-start" />
          {m.collection_duplicate_entry()}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 data-icon="inline-start" />
          {m.space_delete()}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function shouldIgnoreRowOpen(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return true;
  return Boolean(
    target.closest(
      [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='checkbox']",
        "[contenteditable='true']",
        "[data-radix-collection-item]",
      ].join(","),
    ),
  );
}

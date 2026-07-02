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
import { cn } from "@/shared/lib/utils";
import type { CollectionTableRow } from "./types";
import * as m from "@/paraglide/messages.js";

export function SortableTableRow({
  row,
  disabled,
  rowHeightClassName,
  children,
  onOpen,
  onOpenFullPage,
  onDuplicate,
  onDelete,
}: {
  row: CollectionTableRow;
  disabled: boolean;
  rowHeightClassName: string;
  children: ReactNode;
  onOpen: () => void;
  onOpenFullPage: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: row.entry.path, disabled });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ShadcnTableRow
          ref={setNodeRef}
          data-table-row-path={row.entry.path}
          className={cn(
            "group/row h-9 bg-background text-[13px] hover:bg-muted/40",
            rowHeightClassName,
            isDragging && "opacity-60",
          )}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
          }}
          onDoubleClick={(event) => {
            if (shouldIgnoreRowOpen(event.target)) return;
            onOpenFullPage();
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
                  {...attributes}
                  {...listeners}
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
        "[data-table-property-cell]",
      ].join(","),
    ),
  );
}

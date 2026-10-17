import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TableCell } from "@/components/ui/table";
import { cn } from "@/shared/lib/utils";
import type { CollectionTableRow } from "./types";
import { CollectionTableRow as CollectionTableRowShell } from "./table-presentation";
import { CollectionEntryContextMenuItems } from "../entry-context-menu";

export function SortableTableRow({
  row,
  disabled,
  rowHeightClassName,
  selected,
  tabIndex,
  children,
  onOpen,
  onFocus,
  onMoveFocus,
  registerRow,
}: {
  row: CollectionTableRow;
  disabled: boolean;
  rowHeightClassName: string;
  selected: boolean;
  tabIndex: number;
  children: ReactNode;
  onOpen: () => void;
  onFocus: () => void;
  onMoveFocus: (key: string) => void;
  registerRow: (element: HTMLTableRowElement | null) => void;
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
        <CollectionTableRowShell
          rowRef={(element) => {
            setNodeRef(element);
            registerRow(element);
          }}
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
          selected={selected}
          tabIndex={tabIndex}
          onActivate={onOpen}
          onMoveFocus={onMoveFocus}
          onSelect={onFocus}
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
        </CollectionTableRowShell>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <CollectionEntryContextMenuItems
          entry={row.entry}
          nestedCollection={row.nestedCollection}
          onOpenInPeek={onOpen}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

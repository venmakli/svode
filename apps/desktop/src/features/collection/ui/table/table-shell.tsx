import {
  cloneElement,
  isValidElement,
  type ElementType,
  type KeyboardEventHandler,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { AlertCircle, MoreVertical } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow as ShadcnTableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Entry } from "@/features/editor/types";
import type { CollectionSchema } from "@/features/properties/model";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import { PROPERTY_TYPE_ICONS, TITLE_ICON } from "./icons";
import { defaultColumnWidth } from "./utils";
import * as m from "@/paraglide/messages.js";

export function ColumnHeader({
  label,
  icon: Icon,
  open,
  children,
  onOpenChange,
  onResizeMouseDown,
}: {
  field: string;
  label: string;
  icon: ElementType;
  open: boolean;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  onResizeMouseDown: (event: ReactMouseEvent) => void;
}) {
  const trigger = (
    <button
      type="button"
      className={cn(
        "group/header relative flex h-full w-full items-center gap-2 px-2 text-left text-[12px] font-semibold text-muted-foreground hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        open && "bg-accent",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenChange(true);
      }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <MoreVertical
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/header:opacity-100",
          open && "opacity-100",
        )}
      />
    </button>
  );
  return (
    <div className="relative h-full w-full">
      {cloneColumnMenu(children, trigger)}
      <span
        className="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeMouseDown(event);
        }}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

export function TableShell({
  children,
  onKeyDown,
}: {
  children: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      className="overflow-x-auto overflow-y-visible rounded-xl bg-card ring-1 ring-border/70"
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function LoadingTable({
  fields,
  schema,
}: {
  fields: string[];
  schema: CollectionSchema;
}) {
  const columnWidths = fields.map((field) => {
    if (field === "title") return 260;
    const column = schema.columns.find((item) => item.name === field);
    return defaultColumnWidth(column);
  });
  const tableWidth = columnWidths.reduce((sum, width) => sum + width, 62);

  return (
    <div className={detailPageViewClassName}>
      <TableShell>
        <Table
          className="min-w-full table-auto"
          style={{ minWidth: tableWidth, width: "100%" }}
        >
          <TableHeader>
            <ShadcnTableRow className="h-[34px] bg-muted/40">
              <TableHead className="h-[34px] w-[18px] p-0" />
              {fields.map((field, index) => {
                const column = schema.columns.find(
                  (item) => item.name === field,
                );
                const Icon =
                  field === "title"
                    ? TITLE_ICON
                    : PROPERTY_TYPE_ICONS[column?.type ?? "text"];
                return (
                  <TableHead
                    key={field}
                    className="border-r px-2"
                    style={{ width: columnWidths[index] }}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span className="truncate text-xs">{field}</span>
                    </div>
                  </TableHead>
                );
              })}
              <TableHead className="p-0" />
            </ShadcnTableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }).map((_, index) => (
              <ShadcnTableRow key={index} className="h-9">
                <TableCell className="w-[18px] p-1" />
                {fields.map((field, fieldIndex) => (
                  <TableCell
                    key={field}
                    className="h-9 border-r p-2"
                    style={{ width: columnWidths[fieldIndex] }}
                  >
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
                <TableCell className="h-9 p-0" />
              </ShadcnTableRow>
            ))}
          </TableBody>
        </Table>
      </TableShell>
    </div>
  );
}

export function ErrorState({ title }: { title: string }) {
  return (
    <div className={detailPageViewClassName}>
      <Empty className="min-h-48 flex-none border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertCircle />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{m.table_error_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

export function moveFocus(
  direction: 1 | -1,
  entries: Entry[],
  focusedPath: string | null,
  setFocusedPath: (path: string | null) => void,
) {
  if (entries.length === 0) return;
  const current = focusedPath
    ? entries.findIndex((entry) => entry.path === focusedPath)
    : -1;
  const next =
    current < 0
      ? 0
      : Math.max(0, Math.min(entries.length - 1, current + direction));
  setFocusedPath(entries[next]?.path ?? null);
}

function cloneColumnMenu(children: ReactNode, trigger: ReactNode) {
  if (!isValidElement<{ trigger: ReactNode }>(children)) return trigger;
  return cloneElement(children, { trigger });
}

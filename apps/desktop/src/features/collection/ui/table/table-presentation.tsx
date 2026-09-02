import type {
  ComponentProps,
  KeyboardEventHandler,
  MouseEvent,
  PointerEvent,
  ReactNode,
  Ref,
} from "react";

import { TableRow } from "@/components/ui/table";
import { cn } from "@/shared/lib/utils";

import { isCollectionPresentationInteractiveTarget } from "../presentation-chrome";

type CollectionTableMoveKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

export function CollectionTableShell({
  children,
  onKeyDown,
}: {
  children: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      className="overflow-x-auto overflow-y-visible rounded-xl bg-card ring-1 ring-border/70"
      data-collection-table
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function CollectionTableRow({
  children,
  className,
  onActivate,
  onMoveFocus,
  onSelect,
  rowRef,
  selected,
  ...props
}: Omit<
  ComponentProps<typeof TableRow>,
  | "aria-selected"
  | "children"
  | "data-selected"
  | "data-state"
  | "onClick"
  | "onDoubleClick"
  | "onFocus"
  | "onKeyDown"
  | "onPointerDown"
  | "ref"
> & {
  children: ReactNode;
  onActivate?(): void;
  onMoveFocus?(key: CollectionTableMoveKey): void;
  onSelect(): void;
  rowRef?: Ref<HTMLTableRowElement>;
  selected: boolean;
}) {
  return (
    <TableRow
      {...props}
      ref={rowRef}
      aria-selected={selected}
      data-selected={selected || undefined}
      data-state={selected ? "selected" : undefined}
      className={cn(selected && "bg-muted hover:bg-muted", className)}
      onPointerDown={(event) => {
        if (
          event.pointerType === "mouse" &&
          isCollectionTablePrimaryTarget(event)
        ) {
          event.preventDefault();
        }
      }}
      onClick={(event) => {
        if (isCollectionTablePrimaryTarget(event)) {
          event.currentTarget.focus();
          onSelect();
          onActivate?.();
          return;
        }
        if (isCollectionPresentationInteractiveTarget(event)) return;
        event.currentTarget.focus();
        onSelect();
      }}
      onDoubleClick={(event) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        onSelect();
        onActivate?.();
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onSelect();
      }}
      onKeyDown={(event) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        if (isCollectionTableMoveKey(event.key)) {
          event.preventDefault();
          onMoveFocus?.(event.key);
        } else if (event.key === "Enter" && onActivate) {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </TableRow>
  );
}

function isCollectionTableMoveKey(key: string): key is CollectionTableMoveKey {
  return (
    key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End"
  );
}

function isCollectionTablePrimaryTarget(
  event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>,
) {
  const { currentTarget, target } = event;
  if (!(target instanceof Element)) return false;

  const primary = target.closest("[data-collection-primary]");
  return Boolean(primary && currentTarget.contains(primary));
}

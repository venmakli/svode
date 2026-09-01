import type { KeyboardEventHandler, ReactNode } from "react";

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

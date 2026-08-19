import type {
  ComponentProps,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
} from "react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { detailPageToolbarClassName } from "@/shared/ui/page-layout";

import { CollectionListRowShell } from "./presentation-layout";

const interactiveTargetSelector = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='checkbox']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='slider']",
  "[role='switch']",
  "[role='tab']",
  "[data-card-interactive]",
  "[data-list-interactive]",
  "[data-system-collection-interactive]",
  "[data-radix-collection-item]",
].join(",");

const toolbarIconButtonClass =
  "rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground";
const toolbarActiveButtonClass =
  "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground";
const toolbarBadgeButtonClass = "h-7 gap-1 rounded-[7px] px-2";
const toolbarCountBadgeClass =
  "h-3.5 min-w-3.5 rounded-full px-1 text-[10px] leading-none";

export function CollectionPresentationToolbar({
  actions,
  tabs,
}: {
  actions?: ReactNode;
  tabs: ReactNode;
}) {
  return (
    <div
      className={detailPageToolbarClassName}
      data-collection-presentation-toolbar
    >
      {tabs}
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}

export function CollectionPresentationTabTrigger({
  children,
  ...props
}: ComponentProps<typeof TabsTrigger>) {
  return <TabsTrigger {...props}>{children}</TabsTrigger>;
}

export function CollectionToolbarButton({
  active = false,
  count = 0,
  icon: Icon,
  label,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  active?: boolean;
  count?: number;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size={count > 0 ? "sm" : "icon-sm"}
      className={cn(
        toolbarIconButtonClass,
        count > 0 && toolbarBadgeButtonClass,
        (count > 0 || active) && toolbarActiveButtonClass,
      )}
      {...props}
    >
      <Icon />
      <span className="sr-only">{label}</span>
      {count > 0 ? (
        <Badge className={toolbarCountBadgeClass}>{count}</Badge>
      ) : null}
    </Button>
  );
}

export function CollectionQueryToolbarButton(
  props: Parameters<typeof CollectionToolbarButton>[0],
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CollectionToolbarButton {...props} />
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

export function CollectionPresentationPropertyFlow({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function CollectionPresentationPropertyItem({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md px-0.5 text-left text-xs leading-tight",
        className,
      )}
      {...props}
    />
  );
}

export function CollectionPresentationListRow({
  className,
  contextMenu,
  density,
  identity,
  leading,
  onDoubleOpen,
  onFocusRow,
  onMoveFocus,
  onOpen,
  properties,
  rowRef,
  selected = false,
  style,
  tabIndex = 0,
  ...props
}: Omit<
  ComponentProps<typeof CollectionListRowShell>,
  | "children"
  | "contextMenu"
  | "density"
  | "onClick"
  | "onDoubleClick"
  | "onFocus"
  | "onKeyDown"
  | "ref"
  | "selected"
> & {
  contextMenu?: ReactNode;
  density: "compact" | "comfortable";
  identity: ReactNode;
  leading?: ReactNode;
  onDoubleOpen?(): void;
  onFocusRow?(): void;
  onMoveFocus?(key: "ArrowUp" | "ArrowDown" | "Home" | "End"): void;
  onOpen?(): void;
  properties?: ReactNode;
  rowRef?: Ref<HTMLDivElement>;
  selected?: boolean;
}) {
  const row = (
    <CollectionListRowShell
      {...props}
      ref={rowRef}
      className={cn(onOpen && "cursor-pointer", className)}
      density={density}
      selected={selected}
      style={style}
      tabIndex={tabIndex}
      onFocus={onFocusRow}
      onClick={(event) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        event.currentTarget.focus();
        onOpen?.();
      }}
      onDoubleClick={(event) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        onDoubleOpen?.();
      }}
      onKeyDown={(event) => {
        if (isCollectionPresentationInteractiveTarget(event)) return;
        if (
          event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          event.preventDefault();
          onMoveFocus?.(event.key);
        } else if (onOpen && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        } else if (event.key === "Escape") {
          event.currentTarget.blur();
        }
      }}
    >
      <div className="flex min-w-0 items-center justify-center">{leading}</div>
      <div className="min-w-0">{identity}</div>
      {properties ?? <span aria-hidden />}
    </CollectionListRowShell>
  );

  if (!contextMenu) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">{contextMenu}</ContextMenuContent>
    </ContextMenu>
  );
}

export function isCollectionPresentationInteractiveTarget(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
) {
  const { currentTarget, target } = event;
  if (target === currentTarget || !(target instanceof Element)) return false;

  const interactive = target.closest(interactiveTargetSelector);
  return Boolean(
    interactive &&
    interactive !== currentTarget &&
    currentTarget.contains(interactive),
  );
}

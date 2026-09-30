import { useState, type ReactNode } from "react";
import { CircleSlash, Ellipsis, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

interface NavigationSidebarItemProps {
  title: string;
  /** Type icon of the object; a session carries its status marker. */
  icon: ReactNode;
  /** Where the object lives: its Space, and the agent of a session. */
  tooltip: ReactNode;
  /** The object is the main area object. */
  active: boolean;
  /** Its source was not read; it keeps the last known title. */
  unavailable: boolean;
  onOpen: () => void;
  /** Items of the row menu. */
  menu: ReactNode;
  /** The row closes by its own button, e.g. in Now. */
  onClose?: () => void;
  /** The main area object shown only until another one opens. */
  temporary?: boolean;
  /** Double click keeps a temporary row. */
  onKeep?: () => void;
}

/** A row of a navigation section of the sidebar. */
export function NavigationSidebarItem({
  title,
  icon,
  tooltip,
  active,
  unavailable,
  onOpen,
  menu,
  onClose,
  temporary = false,
  onKeep,
}: NavigationSidebarItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            type="button"
            isActive={active}
            aria-current={active ? "page" : undefined}
            aria-disabled={unavailable || undefined}
            className={cn(
              onClose ? "pr-14" : "pr-8",
              temporary && "italic",
              unavailable &&
                "text-sidebar-foreground/50 hover:text-sidebar-foreground/50",
            )}
            onClick={unavailable ? undefined : onOpen}
            onDoubleClick={onKeep}
          >
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden
            >
              {icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {temporary && (
              <span className="sr-only">{m.navigation_temporary()}</span>
            )}
            {unavailable && (
              <CircleSlash
                className="!size-3 shrink-0"
                aria-label={m.navigation_unavailable()}
              />
            )}
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="flex max-w-80 flex-col items-start gap-1 text-left"
        >
          <span className="font-medium">{title}</span>
          {tooltip}
          {unavailable && <span>{m.navigation_unavailable()}</span>}
          {temporary && <span>{m.navigation_temporary()}</span>}
        </TooltipContent>
      </Tooltip>
      {onClose && (
        <SidebarMenuAction
          type="button"
          showOnHover
          className="right-7"
          aria-label={m.navigation_close_item({ title })}
          onClick={onClose}
        >
          <X />
        </SidebarMenuAction>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            type="button"
            showOnHover
            aria-label={m.navigation_item_actions({ title })}
          >
            <Ellipsis />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="min-w-44">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

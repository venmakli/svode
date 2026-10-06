import type { ReactNode } from "react";
import { CircleSlash, Pin, PinOff, SquarePlus, X } from "lucide-react";
import {
  SidebarMenuAction,
  SidebarMenuBadge,
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
import { useKeepInNow } from "../hooks/use-keep-in-now";
import { usePinToggle } from "../hooks/use-pin-toggle";
import type { NavigationItem } from "../model/keys";

interface NavigationSidebarItemProps {
  title: string;
  /** Type icon of the object. */
  icon: ReactNode;
  /**
   * Status of the object, e.g. of a session: its marker takes the place of
   * the row buttons until the row is hovered or focused.
   */
  status?: { marker: ReactNode; label: string };
  /** Where the object lives: its Space, and the agent of a session. */
  tooltip: ReactNode;
  /** The object is the main area object. */
  active: boolean;
  /** Its source was not read; it keeps the last known title. */
  unavailable: boolean;
  onOpen: () => void;
  /**
   * The object of the row's next-step button: Unpin when pinned, otherwise
   * Keep in Now when `keepable` and not kept yet, otherwise Pin.
   */
  stepItem: NavigationItem | null;
  /** A temporary row or an active session, which is kept before pinned. */
  keepable?: boolean;
  /** The row closes by its own button at its end, e.g. in Now. */
  onClose?: () => void;
  /** The main area object shown only until another one opens. */
  temporary?: boolean;
  /** Double click keeps a temporary row. */
  onKeep?: () => void;
  /** A pinned object in a list that mixes it with others. */
  pinned?: boolean;
}

/** A row of a navigation section of the sidebar. */
export function NavigationSidebarItem({
  title,
  icon,
  status,
  tooltip,
  active,
  unavailable,
  onOpen,
  stepItem,
  keepable = false,
  onClose,
  temporary = false,
  onKeep,
  pinned = false,
}: NavigationSidebarItemProps) {
  const step = useStepAction(stepItem, keepable, title);
  const buttons = (step ? 1 : 0) + (onClose ? 1 : 0);
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
              // Two buttons show over the row's end on hover and focus.
              buttons > 1 &&
                "group-focus-within/menu-item:pr-14! group-hover/menu-item:pr-14!",
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
            {pinned && (
              <Pin
                className="!size-3 shrink-0 text-muted-foreground group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0"
                aria-label={m.navigation_pinned_item()}
              />
            )}
            {status && <span className="sr-only">{status.label}</span>}
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
          {status && <span>{status.label}</span>}
          {tooltip}
          {pinned && <span>{m.navigation_pinned_item()}</span>}
          {unavailable && <span>{m.navigation_unavailable()}</span>}
          {temporary && <span>{m.navigation_temporary()}</span>}
        </TooltipContent>
      </Tooltip>
      {status && (
        <SidebarMenuBadge
          aria-hidden
          className="hidden group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0 md:flex"
        >
          {status.marker}
        </SidebarMenuBadge>
      )}
      {step && (
        <SidebarMenuAction
          type="button"
          showOnHover
          className={onClose ? "right-7" : undefined}
          aria-label={step.label}
          disabled={step.pending}
          onClick={step.run}
        >
          {step.icon}
        </SidebarMenuAction>
      )}
      {onClose && (
        <SidebarMenuAction
          type="button"
          showOnHover
          aria-label={m.navigation_close_item({ title })}
          onClick={onClose}
        >
          <X />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );
}

/** The row's next step: Unpin, Keep in Now or Pin; none for no identity. */
function useStepAction(
  item: NavigationItem | null,
  keepable: boolean,
  title: string,
) {
  const pin = usePinToggle(item);
  const keep = useKeepInNow(item);
  if (!pin.available) return null;
  if (pin.pinned) {
    return {
      icon: <PinOff />,
      label: m.navigation_unpin_item({ title }),
      pending: pin.pending,
      run: pin.toggle,
    };
  }
  if (keepable && keep.available) {
    return {
      icon: <SquarePlus />,
      label: m.navigation_keep_item({ title }),
      pending: keep.pending,
      run: keep.keep,
    };
  }
  return {
    icon: <Pin />,
    label: m.navigation_pin_item({ title }),
    pending: pin.pending,
    run: pin.toggle,
  };
}

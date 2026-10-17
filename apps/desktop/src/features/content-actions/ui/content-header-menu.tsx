import { useRef } from "react";
import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NavigationItem } from "@/features/navigation";
import * as m from "@/paraglide/messages.js";
import type { ContentActionGroup } from "../model/catalog";
import {
  ContentActionMenuItems,
  type ContentActionHandlers,
} from "./content-action-menu-items";

/**
 * The "⋮" menu of an object's header, built from its catalog groups. Rename
 * moves focus to a name field, so it runs once the menu has closed instead of
 * the menu handing focus back to its trigger.
 */
export function ContentHeaderMenu({
  groups,
  pinItem = null,
  handlers,
}: {
  groups: readonly ContentActionGroup[];
  pinItem?: NavigationItem | null;
  handlers: ContentActionHandlers;
}) {
  const afterCloseRef = useRef<(() => void) | null>(null);
  const rename = handlers.rename;
  const shownHandlers: ContentActionHandlers = rename
    ? {
        ...handlers,
        rename: () => {
          afterCloseRef.current = rename;
        },
      }
    : handlers;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <MoreVertical />
          <span className="sr-only">{m.content_actions()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        onCloseAutoFocus={(event) => {
          const afterClose = afterCloseRef.current;
          if (!afterClose) return;
          afterCloseRef.current = null;
          event.preventDefault();
          afterClose();
        }}
      >
        <ContentActionMenuItems
          groups={groups}
          pinItem={pinItem}
          handlers={shownHandlers}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

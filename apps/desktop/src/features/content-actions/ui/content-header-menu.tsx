import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { NavigationItem } from "@/features/navigation";
import * as m from "@/paraglide/messages.js";
import { useContentMenuHandlers } from "../hooks/use-content-menu-handlers";
import type { ContentActionGroup } from "../model/catalog";
import {
  ContentActionMenuItems,
  type ContentActionHandlers,
} from "./content-action-menu-items";

/** The "⋮" menu of an object's header, built from its catalog groups. */
export function ContentHeaderMenu({
  groups,
  pinItem = null,
  handlers,
}: {
  groups: readonly ContentActionGroup[];
  pinItem?: NavigationItem | null;
  handlers: ContentActionHandlers;
}) {
  const menu = useContentMenuHandlers(handlers);

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
        onCloseAutoFocus={menu.onCloseAutoFocus}
      >
        <ContentActionMenuItems
          groups={groups}
          pinItem={pinItem}
          handlers={menu.handlers}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

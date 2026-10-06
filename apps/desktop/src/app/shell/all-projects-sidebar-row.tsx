import { ArrowLeft, Home } from "lucide-react";
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { isMacKeyboardPlatform } from "@/shared/lib/keyboard-shortcuts";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { cn } from "@/shared/lib/utils";
import { useGoHome } from "./hooks/use-go-home";
import { allProjectsShortcut } from "./model/shortcut-descriptions";
import * as m from "@/paraglide/messages.js";

const REVEAL_ON_ROW =
  "group-hover/menu-item:block group-focus-within/menu-item:block";
const HIDE_ON_ROW =
  "group-hover/menu-item:hidden group-focus-within/menu-item:hidden";

/**
 * "All projects" of the main sidebar: the way up to Home. On hover and focus
 * the house turns into a back arrow and the ⌘0 hint appears.
 */
export function AllProjectsSidebarRow() {
  const goHome = useGoHome();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => void goHome()}
        aria-keyshortcuts={isMacKeyboardPlatform() ? "Meta+0" : "Control+0"}
      >
        <Home className={HIDE_ON_ROW} />
        <ArrowLeft className={`hidden ${REVEAL_ON_ROW}`} />
        <span>{m.sidebar_all_projects()}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge
        aria-hidden
        className={cn(
          "opacity-0 transition-opacity motion-reduce:transition-none",
          "group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100",
        )}
      >
        {shortcutLabel(allProjectsShortcut)}
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/shared/lib/utils";
import { NavSpaces } from "./nav-spaces";
import * as m from "@/paraglide/messages.js";

interface SpaceSidebarProps {
  userMenu: ReactNode;
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
  onOpenSearch: () => void;
  /** The Search shortcut of this platform, shown on the Search row. */
  searchShortcut: string;
  /** Starts a new agent session in the Space at this path. */
  onNewSession?: (spacePath: string) => void;
  /** Opens a new terminal panel tab in the Space at this path. */
  onNewTerminal?: (spacePath: string) => void;
  /** The "All projects" row, first in the sidebar. */
  allProjectsItem?: ReactNode;
  /** The "New session" row above Search. */
  newSessionItem?: ReactNode;
  /** Navigation sections between the top actions and the Artifacts tree. */
  navigationSections?: ReactNode;
}

export function SpaceSidebar({
  userMenu,
  onActivateContent,
  onBeforeNavigation,
  onOpenSearch,
  searchShortcut,
  onNewSession,
  onNewTerminal,
  allProjectsItem,
  newSessionItem,
  navigationSections,
}: SpaceSidebarProps) {
  return (
    <Sidebar variant="sidebar" collapsible="offcanvas" className="!border-r-0">
      <SidebarHeader className="h-[44px] shrink-0 py-0" />

      <SidebarContent>
        <TopLevelSidebarActions
          allProjectsItem={allProjectsItem}
          newSessionItem={newSessionItem}
          onOpenSearch={onOpenSearch}
          searchShortcut={searchShortcut}
        />
        {navigationSections}
        <NavSpaces
          onActivateContent={onActivateContent}
          onBeforeNavigation={onBeforeNavigation}
          onNewSession={onNewSession}
          onNewTerminal={onNewTerminal}
        />
      </SidebarContent>

      <SidebarFooter>{userMenu}</SidebarFooter>
    </Sidebar>
  );
}

function TopLevelSidebarActions({
  allProjectsItem,
  newSessionItem,
  onOpenSearch,
  searchShortcut,
}: {
  allProjectsItem?: ReactNode;
  newSessionItem?: ReactNode;
  onOpenSearch: () => void;
  searchShortcut: string;
}) {
  return (
    <SidebarMenu className="px-2 py-2">
      {allProjectsItem}
      {newSessionItem}
      <SidebarMenuItem>
        <SidebarMenuButton onClick={onOpenSearch}>
          <Search />
          <span>{m.search_tooltip()}</span>
        </SidebarMenuButton>
        <SidebarMenuBadge
          className={cn(
            "opacity-0 transition-opacity",
            "group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100",
          )}
        >
          {searchShortcut}
        </SidebarMenuBadge>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

import type { ReactNode } from "react";
import { BotMessageSquare, Search } from "lucide-react";
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

type MainSurface = "content" | "sessions" | "graph";

interface SpaceSidebarProps {
  userMenu: ReactNode;
  mainSurface: MainSurface;
  onActivateContent: () => void;
  onBeforeNavigation: () => Promise<boolean>;
  onOpenSessions: () => void;
  onOpenSearch: () => void;
}

export function SpaceSidebar({
  userMenu,
  mainSurface,
  onActivateContent,
  onBeforeNavigation,
  onOpenSessions,
  onOpenSearch,
}: SpaceSidebarProps) {
  return (
    <Sidebar variant="sidebar" collapsible="offcanvas" className="!border-r-0">
      <SidebarHeader className="h-[44px] shrink-0 py-0" />

      <SidebarContent>
        <TopLevelSidebarActions
          mainSurface={mainSurface}
          onOpenSessions={onOpenSessions}
          onOpenSearch={onOpenSearch}
        />
        <NavSpaces
          onActivateContent={onActivateContent}
          onBeforeNavigation={onBeforeNavigation}
        />
      </SidebarContent>

      <SidebarFooter>{userMenu}</SidebarFooter>
    </Sidebar>
  );
}

function TopLevelSidebarActions({
  mainSurface,
  onOpenSessions,
  onOpenSearch,
}: {
  mainSurface: MainSurface;
  onOpenSessions: () => void;
  onOpenSearch: () => void;
}) {
  return (
    <SidebarMenu className="px-2 py-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={mainSurface === "sessions"}
          onClick={onOpenSessions}
        >
          <BotMessageSquare />
          <span>{m.sidebar_sessions()}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
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
          {"\u2318"}P
        </SidebarMenuBadge>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

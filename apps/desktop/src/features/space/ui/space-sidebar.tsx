import { BotMessageSquare, ChevronsUpDown, Inbox, Search } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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

type MainSurface = "content" | "inbox" | "sessions";

interface SpaceSidebarProps {
  identityName: string | null;
  identityEmail: string | null;
  identityAvatarColor: string;
  mainSurface: MainSurface;
  onActivateContent: () => void;
  onOpenInbox: () => void;
  onOpenSessions: () => void;
  onOpenSearch: () => void;
  onOpenAppSettings: () => void;
}

export function SpaceSidebar({
  identityName,
  identityEmail,
  identityAvatarColor,
  mainSurface,
  onActivateContent,
  onOpenInbox,
  onOpenSessions,
  onOpenSearch,
  onOpenAppSettings,
}: SpaceSidebarProps) {
  const userName = identityName || "User";
  const initials = userName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <Sidebar variant="sidebar" collapsible="offcanvas" className="!border-r-0">
      <SidebarHeader className="h-[44px] shrink-0 py-0" />

      <SidebarContent>
        <TopLevelSidebarActions
          mainSurface={mainSurface}
          onOpenInbox={onOpenInbox}
          onOpenSessions={onOpenSessions}
          onOpenSearch={onOpenSearch}
        />
        <NavSpaces onActivateContent={onActivateContent} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="w-full"
              onClick={onOpenAppSettings}
            >
              <Avatar className="size-8 rounded-lg after:rounded-lg">
                <AvatarFallback
                  className="rounded-lg text-xs font-medium text-white"
                  style={{ backgroundColor: identityAvatarColor }}
                >
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{userName}</span>
                <span className="truncate text-xs">{identityEmail ?? ""}</span>
              </div>
              <ChevronsUpDown className="ml-auto opacity-50" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function TopLevelSidebarActions({
  mainSurface,
  onOpenInbox,
  onOpenSessions,
  onOpenSearch,
}: {
  mainSurface: MainSurface;
  onOpenInbox: () => void;
  onOpenSessions: () => void;
  onOpenSearch: () => void;
}) {
  return (
    <SidebarMenu className="px-2 py-2">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={mainSurface === "inbox"}
          onClick={onOpenInbox}
        >
          <Inbox />
          <span>{m.sidebar_inbox()}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
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

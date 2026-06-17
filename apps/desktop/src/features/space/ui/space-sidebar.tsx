import { ChevronsUpDown, Inbox, MessageSquare, Search } from "lucide-react";
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
import { useEffectiveIdentity } from "@/features/identity";
import { avatarColorFromEmail } from "@/features/identity";
import { cn } from "@/shared/lib/utils";
import { NavSpaces } from "./nav-spaces";
import * as m from "@/paraglide/messages.js";

type MainSurface = "content" | "inbox" | "sessions";

interface SpaceSidebarProps {
  mainSurface: MainSurface;
  onActivateContent: () => void;
  onOpenInbox: () => void;
  onOpenSessions: () => void;
  onOpenSearch: () => void;
  onOpenAppSettings: () => void;
  onOpenSpaceSettings: (spacePath: string) => void;
}

export function SpaceSidebar({
  mainSurface,
  onActivateContent,
  onOpenInbox,
  onOpenSessions,
  onOpenSearch,
  onOpenAppSettings,
  onOpenSpaceSettings,
}: SpaceSidebarProps) {
  const { name: identityName, email: identityEmail } = useEffectiveIdentity();

  const userName = identityName || "User";
  const userAvatar = avatarColorFromEmail(identityEmail);
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
        <NavSpaces
          onActivateContent={onActivateContent}
          onOpenSpaceSettings={onOpenSpaceSettings}
        />
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
                  style={{ backgroundColor: userAvatar }}
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
          <MessageSquare />
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

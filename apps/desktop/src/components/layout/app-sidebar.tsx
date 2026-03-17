import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, ChevronUp, Monitor, Moon, Plus, Settings, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { useAppVersion } from "@/hooks/use-app-version";
import * as m from "@/paraglide/messages.js";

export function AppSidebar() {
  const { setTheme } = useTheme();
  const version = useAppVersion();

  return (
    <Sidebar variant="floating" collapsible="offcanvas" className="pt-[44px]">
      <SidebarHeader>
        {/* Project selector */}
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="w-full">
                  <span className="mr-2">📋</span>
                  <span className="font-medium truncate">My Project</span>
                  <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[var(--radix-dropdown-menu-trigger-width)]">
                <DropdownMenuItem>
                  <Settings className="mr-2 h-4 w-4" />
                  {m.sidebar_project_settings()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>{m.sidebar_all_projects()}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{m.sidebar_workspaces()}</SidebarGroupLabel>
          <SidebarGroupAction title="Add workspace">
            <Plus />
            <span className="sr-only">Add workspace</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive className="w-full font-medium">
                  <span className="mr-2">⚙️</span>
                  <span className="truncate">Backend</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton className="w-full">
                  <span className="mr-2">🎨</span>
                  <span className="truncate">Frontend</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="w-full">
                  <span className="mr-2">👤</span>
                  <span className="truncate">User</span>
                  <ChevronUp className="ml-auto h-4 w-4 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[var(--radix-dropdown-menu-trigger-width)]">
                <DropdownMenuItem>
                  <Settings className="mr-2 h-4 w-4" />
                  {m.common_settings()}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Sun className="mr-2 h-4 w-4" />
                    {m.common_theme()}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => setTheme("light")}>
                        <Sun className="mr-2 h-4 w-4" />
                        {m.common_theme_light()}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme("dark")}>
                        <Moon className="mr-2 h-4 w-4" />
                        {m.common_theme_dark()}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme("system")}>
                        <Monitor className="mr-2 h-4 w-4" />
                        {m.common_theme_system()}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem>{m.common_about()}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        <p className="pb-2 text-center text-xs text-muted-foreground">Version {version}</p>
      </SidebarFooter>
    </Sidebar>
  );
}

import { useNavigate } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
import { Check, ChevronDown, ChevronUp, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { useAppVersion } from "@/hooks/use-app-version";
import { useWorkspaceStore } from "@/stores/workspace";
import { NavWorkspaces } from "@/components/workspace/nav-workspaces";
import * as m from "@/paraglide/messages.js";

export function AppSidebar() {
  const { setTheme } = useTheme();
  const version = useAppVersion();
  const navigate = useNavigate();
  const {
    projects,
    activeProjectId,
    activeProjectName,
    activeProjectIcon,
    openProject,
    goHome,
  } = useWorkspaceStore();

  function handleGoHome() {
    goHome();
    navigate({ to: "/" });
  }

  function handleSwitchProject(id: string) {
    openProject(id);
  }

  return (
    <Sidebar variant="floating" collapsible="offcanvas" className="pt-[44px]">
      <SidebarHeader>
        {/* Project selector */}
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="w-full">
                  <span className="mr-2">{activeProjectIcon || "\u{1F4CB}"}</span>
                  <span className="font-medium truncate">
                    {activeProjectName || "Project"}
                  </span>
                  <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[var(--radix-dropdown-menu-trigger-width)]">
                <DropdownMenuItem disabled>
                  <Settings className="mr-2 h-4 w-4" />
                  {m.sidebar_project_settings()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {projects.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => handleSwitchProject(p.id)}
                  >
                    <span className="mr-2">{p.icon}</span>
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.id === activeProjectId && (
                      <Check className="ml-2 h-4 w-4" />
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleGoHome}>
                  {m.sidebar_all_projects()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavWorkspaces />
      </SidebarContent>

      <SidebarFooter>
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="w-full">
                  <span className="mr-2">{"\u{1F464}"}</span>
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

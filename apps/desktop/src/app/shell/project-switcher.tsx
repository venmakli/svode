import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Home,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { RootProjectDialogs, useRootProjectWorkflow } from "@/features/home";
import { useSpace } from "@/features/space";
import { useShellStore } from "./model";
import * as m from "@/paraglide/messages.js";

interface ProjectSwitcherProps {
  className?: string;
}

export function ProjectSwitcher({ className }: ProjectSwitcherProps) {
  const navigate = useNavigate();
  const {
    rootSpaces,
    activeRootId,
    activeRootName,
    activeRootIcon,
    goHome,
  } = useSpace();
  const openContentSurface = useCallback(() => {
    useShellStore.getState().openContentSurface();
  }, []);
  const {
    cloneDialogOpen,
    createDialogOpen,
    handleCloneProject,
    handleCreateProject,
    handleOpenProjectFolder,
    openProject,
    setCloneDialogOpen,
    setCreateDialogOpen,
  } = useRootProjectWorkflow({ onRootOpened: openContentSurface });

  function handleHome() {
    goHome();
    navigate({ to: "/" });
  }

  return (
    <>
      <SidebarMenu className={className}>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton className="w-fit max-w-full px-1.5">
                <span className="text-base leading-none">
                  {activeRootIcon || "\u{1F4C1}"}
                </span>
                <span className="truncate font-medium">
                  {activeRootName || "Project"}
                </span>
                <ChevronDown className="opacity-50" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-max min-w-48 max-w-72 rounded-lg"
              align="start"
              side="bottom"
              sideOffset={4}
            >
              <DropdownMenuItem onClick={handleHome}>
                <Home />
                {m.sidebar_all_projects()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCreateDialogOpen(true)}>
                <FolderPlus />
                {m.home_create_project()}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenProjectFolder}>
                <FolderOpen />
                {m.home_open_project()}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCloneDialogOpen(true)}>
                <FolderGit2 />
                {m.home_clone_project()}
              </DropdownMenuItem>
              {rootSpaces.length > 0 && <DropdownMenuSeparator />}
              {rootSpaces.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onClick={() => void openProject(project.id)}
                >
                  <span>{project.icon}</span>
                  <span className="truncate pr-3">{project.name}</span>
                  {project.id === activeRootId && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <RootProjectDialogs
        cloneOpen={cloneDialogOpen}
        createOpen={createDialogOpen}
        onCloneOpenChange={setCloneDialogOpen}
        onCloneProject={handleCloneProject}
        onCreateOpenChange={setCreateDialogOpen}
        onCreateProject={handleCreateProject}
      />
    </>
  );
}

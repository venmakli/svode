import { useCallback } from "react";
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { RootProjectDialogs, useRootProjectWorkflow } from "@/features/home";
import { useSpace } from "@/features/space";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { cn } from "@/shared/lib/utils";
import { useShellStore } from "./model";
import { allProjectsShortcut } from "./model/shortcut-descriptions";
import * as m from "@/paraglide/messages.js";
import { passNavigationGuards } from "./navigation-guards";
import { useGoHome } from "./hooks/use-go-home";

interface ProjectSwitcherProps {
  className?: string;
}

export function ProjectSwitcher({ className }: ProjectSwitcherProps) {
  const { rootSpaces, activeRootId, activeRootName, activeRootIcon } =
    useSpace();
  const goHome = useGoHome();
  const openContentSurface = useCallback(() => {
    useShellStore.getState().openContentSurface();
  }, []);
  const {
    cloneAuthChallenge,
    cloneAuthError,
    cloneAuthOpen,
    cloneAuthSaving,
    cloneDialogOpen,
    createDialogOpen,
    handleCloneProject,
    handleCreateProject,
    handleOpenProjectFolder,
    openProject,
    saveCloneAuthAndRetry,
    setCloneAuthOpen,
    setCloneDialogOpen,
    setCreateDialogOpen,
  } = useRootProjectWorkflow({
    beforeRootOpen: passNavigationGuards,
    onRootOpened: openContentSurface,
  });

  return (
    <>
      <div className={cn("flex min-w-0 items-center gap-1", className)}>
        <SidebarMenu className="min-w-0 flex-1">
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
                <DropdownMenuItem onClick={() => void goHome()}>
                  <Home />
                  {m.sidebar_all_projects()}
                  <DropdownMenuShortcut>
                    {shortcutLabel(allProjectsShortcut)}
                  </DropdownMenuShortcut>
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
                    disabled={project.status !== "ready"}
                    onClick={() => void openProject(project.id)}
                  >
                    <span>{project.icon}</span>
                    <span className="truncate pr-3">{project.name}</span>
                    {project.id === activeRootId && (
                      <Check className="ml-auto" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>

      <RootProjectDialogs
        cloneAuthChallenge={cloneAuthChallenge}
        cloneAuthError={cloneAuthError}
        cloneAuthOpen={cloneAuthOpen}
        cloneAuthSaving={cloneAuthSaving}
        cloneOpen={cloneDialogOpen}
        createOpen={createDialogOpen}
        onCloneAuthOpenChange={setCloneAuthOpen}
        onCloneAuthSaveAndRetry={saveCloneAuthAndRetry}
        onCloneOpenChange={setCloneDialogOpen}
        onCloneProject={handleCloneProject}
        onCreateOpenChange={setCreateDialogOpen}
        onCreateProject={handleCreateProject}
      />
    </>
  );
}

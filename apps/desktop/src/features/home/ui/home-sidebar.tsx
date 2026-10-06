import { useCallback, useMemo, type ReactNode } from "react";
import { FolderGit2, FolderOpen, FolderPlus } from "lucide-react";
import { Progress } from "@/components/ui/progress";
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
import { NavigationSidebarGroup } from "@/features/navigation";
import type { SpaceInfo } from "@/features/space";
import { shortcutLabel } from "@/shared/lib/shortcut-description";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import { useCreateProjectShortcut } from "../hooks/use-create-project-shortcut";
import { useHomeProjects } from "../hooks/use-home-projects";
import { useRootProjectWorkflow } from "../hooks/use-root-project-workflow";
import { homeProjectsWithSharedNames } from "../model/home-projects";
import type { CloningProject } from "../model/root-project";
import { homeShortcuts } from "../model/shortcuts";
import { HomeProjectRow } from "./home-project-row";
import { RootProjectDialogs } from "./root-project-dialogs";

interface HomeSidebarProps {
  userMenu: ReactNode;
  onBeforeNavigation: () => Promise<boolean>;
  onActivateContent: () => void;
  /** "Start chat": a new chat with the project in the main area. */
  onStartChat: (project: SpaceInfo) => void;
}

/**
 * The sidebar of Home with projects: project actions, the projects with
 * their rows and the user footer.
 */
export function HomeSidebar({
  userMenu,
  onBeforeNavigation,
  onActivateContent,
  onStartChat,
}: HomeSidebarProps) {
  const workflow = useRootProjectWorkflow({
    beforeRootOpen: onBeforeNavigation,
    onRootOpened: onActivateContent,
  });
  const { setCreateDialogOpen } = workflow;
  const openCreateDialog = useCallback(
    () => setCreateDialogOpen(true),
    [setCreateDialogOpen],
  );
  useCreateProjectShortcut(openCreateDialog);
  const { projects, availability } = useHomeProjects();
  const sharedNames = useMemo(
    () => homeProjectsWithSharedNames(projects),
    [projects],
  );

  return (
    <Sidebar variant="sidebar" collapsible="offcanvas" className="!border-r-0">
      <SidebarHeader className="h-[44px] shrink-0 py-0" />

      <SidebarContent>
        <SidebarMenu className="px-2 py-2">
          <SidebarMenuItem>
            <SidebarMenuButton onClick={openCreateDialog}>
              <FolderPlus />
              <span>{m.home_create_project()}</span>
            </SidebarMenuButton>
            <SidebarMenuBadge
              aria-hidden
              className={cn(
                "opacity-0 transition-opacity motion-reduce:transition-none",
                "group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100",
              )}
            >
              {shortcutLabel(homeShortcuts[0])}
            </SidebarMenuBadge>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => void workflow.handleOpenProjectFolder()}
            >
              <FolderOpen />
              <span>{m.home_open_project()}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => workflow.setCloneDialogOpen(true)}
            >
              <FolderGit2 />
              <span>{m.home_clone_project()}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <NavigationSidebarGroup id="home-projects" label={m.home_projects()}>
          {workflow.cloningProject && (
            <CloningProjectRow project={workflow.cloningProject} />
          )}
          {projects.map((project) => (
            <HomeProjectRow
              key={project.id}
              project={project}
              availability={availability(project)}
              sharedName={sharedNames.has(project.id)}
              onOpen={() =>
                void workflow.openProject(project.id, {
                  otherWindow: availability(project) === "otherWindow",
                })
              }
              onStartChat={() => onStartChat(project)}
              onRemove={(deleteFiles) =>
                void workflow.handleDeleteProject(project.id, deleteFiles)
              }
            />
          ))}
        </NavigationSidebarGroup>
      </SidebarContent>

      <SidebarFooter>{userMenu}</SidebarFooter>

      <RootProjectDialogs
        cloneAuthChallenge={workflow.cloneAuthChallenge}
        cloneAuthError={workflow.cloneAuthError}
        cloneAuthOpen={workflow.cloneAuthOpen}
        cloneAuthSaving={workflow.cloneAuthSaving}
        cloneOpen={workflow.cloneDialogOpen}
        createOpen={workflow.createDialogOpen}
        onCloneAuthOpenChange={workflow.setCloneAuthOpen}
        onCloneAuthSaveAndRetry={workflow.saveCloneAuthAndRetry}
        onCloneOpenChange={workflow.setCloneDialogOpen}
        onCloneProject={workflow.handleCloneProject}
        onCreateOpenChange={workflow.setCreateDialogOpen}
        onCreateProject={workflow.handleCreateProject}
      />
    </Sidebar>
  );
}

/** A project being cloned: its progress until it becomes a project row. */
function CloningProjectRow({ project }: { project: CloningProject }) {
  return (
    <SidebarMenuItem>
      <div className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm opacity-70">
        <span className="truncate">{project.name}</span>
        {project.error ? (
          <span className="truncate text-xs text-destructive">
            {project.error}
          </span>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              {m.home_cloning()} {project.percent}%
            </span>
            <Progress value={project.percent} className="h-1" />
          </>
        )}
      </div>
    </SidebarMenuItem>
  );
}

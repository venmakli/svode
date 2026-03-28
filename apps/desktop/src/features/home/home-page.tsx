import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as m from "@/paraglide/messages.js";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Plus, FolderOpen } from "lucide-react";
import { useAppVersion } from "@/hooks/use-app-version";
import { useWorkspaceStore } from "@/stores/workspace";
import { ProjectList } from "./project-list";
import { EmptyState } from "./empty-state";
import { CreateProjectDialog } from "./create-project-dialog";

export function HomePage() {
  const navigate = useNavigate();
  const version = useAppVersion();
  const [dialogOpen, setDialogOpen] = useState(false);
  const autoOpenAttempted = useRef(false);

  const {
    projects,
    isLoadingProjects,
    loadProjects,
    openProject,
    createProject,
    createDirectoryProject,
    openProjectFolder,
    deleteProject,
    getLastActiveProjectId,
    explicitHome,
  } = useWorkspaceStore();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Auto-open last active project (skip if user explicitly navigated home)
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    if (isLoadingProjects) return;
    if (explicitHome) return;

    autoOpenAttempted.current = true;

    (async () => {
      const lastActiveId = await getLastActiveProjectId();
      if (lastActiveId && projects.some((p) => p.id === lastActiveId)) {
        await openProject(lastActiveId);
        navigate({ to: "/workspace" });
      }
    })();
  }, [isLoadingProjects, projects, getLastActiveProjectId, openProject, navigate, explicitHome]);

  // Keyboard shortcut: Cmd+N to create project
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setDialogOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleOpenProject = useCallback(
    async (id: string) => {
      await openProject(id);
      navigate({ to: "/workspace" });
    },
    [openProject, navigate],
  );

  const handleCreateProject = useCallback(
    async (
      name: string,
      icon: string,
      description?: string,
      variant?: string,
      path?: string,
    ) => {
      try {
        let project;
        if (variant === "directory" && path) {
          project = await createDirectoryProject(name, icon, description, path);
        } else {
          project = await createProject(name, icon, description);
        }
        setDialogOpen(false);
        await openProject(project.id);
        navigate({ to: "/workspace" });
      } catch (err) {
        console.error("Failed to create project:", err);
        toast.error(m.toast_error());
      }
    },
    [createProject, createDirectoryProject, openProject, navigate],
  );

  const handleOpenProjectFolder = useCallback(async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    try {
      const project = await openProjectFolder(selected);
      await openProject(project.id);
      navigate({ to: "/workspace" });
    } catch (err) {
      console.error("Failed to open project folder:", err);
      toast.error(m.home_open_project_error());
    }
  }, [openProjectFolder, openProject, navigate]);

  const handleDeleteProject = useCallback(
    async (id: string) => {
      try {
        await deleteProject(id);
      } catch (err) {
        console.error("Failed to delete project:", err);
      }
    },
    [deleteProject],
  );

  const hasProjects = projects.length > 0 || isLoadingProjects;

  return (
    <div className="flex flex-col h-screen">
      {/* Drag region header */}
      <div
        data-tauri-drag-region
        className="h-[44px] shrink-0 w-full"
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <h1 className="text-2xl font-semibold mb-4">{m.home_title()}</h1>

        <div className="flex gap-3 mb-8">
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {m.home_create_project()}
          </Button>
          <Button variant="outline" onClick={handleOpenProjectFolder}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {m.home_open_project()}
          </Button>
        </div>

        {hasProjects ? (
          <ProjectList
            projects={projects}
            isLoading={isLoadingProjects}
            onOpenProject={handleOpenProject}
            onDeleteProject={handleDeleteProject}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Version at bottom-left */}
      <div className="px-4 pb-3">
        <p className="text-xs text-muted-foreground">v{version}</p>
      </div>

      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateProject}
      />
    </div>
  );
}

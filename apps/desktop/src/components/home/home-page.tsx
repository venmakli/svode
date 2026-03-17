import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { useAppVersion } from "@/hooks/use-app-version";
import { useWorkspaceStore } from "@/stores/workspace";
import { ProjectList } from "./project-list";
import { EmptyState } from "./empty-state";
import { CreateProjectDialog } from "./create-project-dialog";

export function HomePage() {
  const navigate = useNavigate();
  const version = useAppVersion();
  const [dialogOpen, setDialogOpen] = useState(false);

  const {
    projects,
    isLoadingProjects,
    loadProjects,
    openProject,
    createProject,
    deleteProject,
  } = useWorkspaceStore();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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
    async (name: string, icon: string, description?: string) => {
      try {
        const project = await createProject(name, icon, description);
        setDialogOpen(false);
        await openProject(project.id);
        navigate({ to: "/workspace" });
      } catch (err) {
        console.error("Failed to create project:", err);
      }
    },
    [createProject, openProject, navigate],
  );

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
        <h1 className="text-2xl font-semibold mb-8">{m.home_title()}</h1>

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

        <Button
          className="mt-8"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          {m.home_create_project()}
        </Button>
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

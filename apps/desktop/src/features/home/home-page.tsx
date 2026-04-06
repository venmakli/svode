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
    rootWorkspaces,
    isLoadingRoots,
    loadRootWorkspaces,
    openRoot,
    createRoot,
    openRootFolder,
    deleteRoot,
    getLastActiveRootId,
    explicitHome,
  } = useWorkspaceStore();

  useEffect(() => {
    loadRootWorkspaces();
  }, [loadRootWorkspaces]);

  // Auto-open last active project (skip if user explicitly navigated home)
  useEffect(() => {
    if (autoOpenAttempted.current) return;
    if (isLoadingRoots) return;
    if (explicitHome) return;

    autoOpenAttempted.current = true;

    (async () => {
      const lastActiveId = await getLastActiveRootId();
      if (lastActiveId && rootWorkspaces.some((w) => w.id === lastActiveId)) {
        await openRoot(lastActiveId);
        navigate({ to: "/workspace" });
      }
    })();
  }, [isLoadingRoots, rootWorkspaces, getLastActiveRootId, openRoot, navigate, explicitHome]);

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
      await openRoot(id);
      navigate({ to: "/workspace" });
    },
    [openRoot, navigate],
  );

  const handleCreateProject = useCallback(
    async (name: string, icon: string, description: string | undefined, path: string) => {
      try {
        const ws = await createRoot(name, icon, description, path);
        setDialogOpen(false);
        await openRoot(ws.id);
        navigate({ to: "/workspace" });
      } catch (err) {
        console.error("Failed to create project:", err);
        toast.error(m.toast_error());
      }
    },
    [createRoot, openRoot, navigate],
  );

  const handleOpenProjectFolder = useCallback(async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    try {
      const ws = await openRootFolder(selected);
      await openRoot(ws.id);
      navigate({ to: "/workspace" });
    } catch (err) {
      console.error("Failed to open project folder:", err);
      toast.error(m.home_open_project_error());
    }
  }, [openRootFolder, openRoot, navigate]);

  const handleDeleteProject = useCallback(
    async (id: string, deleteFiles: boolean) => {
      try {
        await deleteRoot(id, deleteFiles);
      } catch (err) {
        console.error("Failed to delete project:", err);
      }
    },
    [deleteRoot],
  );

  const hasProjects = rootWorkspaces.length > 0 || isLoadingRoots;

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
            projects={rootWorkspaces}
            isLoading={isLoadingRoots}
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

import { useEffect, useRef } from "react";
import * as m from "@/paraglide/messages.js";
import { FolderPlus, FolderOpen, FolderGit2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useAppVersion } from "@/features/settings";
import { ProjectList } from "./project-list";
import { EmptyState } from "./empty-state";
import { RootProjectDialogs } from "./root-project-dialogs";
import { useRootProjectWorkflow } from "../hooks/use-root-project-workflow";

export function HomePage() {
  const version = useAppVersion();
  const autoOpenAttempted = useRef(false);

  const {
    cloneDialogOpen,
    cloningProject,
    createDialogOpen,
    handleCloneProject,
    handleCreateProject,
    handleDeleteProject,
    handleOpenProjectFolder,
    initializeHome,
    isLoadingRoots,
    openProject,
    rootSpaces,
    setCloneDialogOpen,
    setCreateDialogOpen,
  } = useRootProjectWorkflow();

  useEffect(() => {
    if (autoOpenAttempted.current) return;
    autoOpenAttempted.current = true;

    (async () => {
      await initializeHome();
    })();
  }, [initializeHome]);

  // Keyboard shortcut: Cmd+N to create project
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setCreateDialogOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setCreateDialogOpen]);

  const hasProjects = rootSpaces.length > 0 || isLoadingRoots;

  return (
    <div className="flex flex-col h-screen">
      {/* Drag region header */}
      <div data-tauri-drag-region className="h-[44px] shrink-0 w-full" />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        {/* Branding */}
        <div className="text-center mb-6">
          <img src="/logo.png" alt="Svode" className="h-12 w-12 mx-auto mb-2" />
          <h1 className="text-2xl font-semibold">{m.home_title()}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {m.home_version({ version })}
          </p>
        </div>

        {/* Action cards */}
        <div className="flex gap-3 mb-8">
          <Card
            className="flex flex-col justify-between w-40 h-24 p-4 hover:bg-accent transition-colors cursor-pointer"
            onClick={() => setCreateDialogOpen(true)}
          >
            <FolderPlus className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {m.home_create_project()}
            </span>
          </Card>
          <Card
            className="flex flex-col justify-between w-40 h-24 p-4 hover:bg-accent transition-colors cursor-pointer"
            onClick={handleOpenProjectFolder}
          >
            <FolderOpen className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">{m.home_open_project()}</span>
          </Card>
          <Card
            className="flex flex-col justify-between w-40 h-24 p-4 hover:bg-accent transition-colors cursor-pointer"
            onClick={() => setCloneDialogOpen(true)}
          >
            <FolderGit2 className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium">
              {m.home_clone_project()}
            </span>
          </Card>
        </div>

        {hasProjects ? (
          <ProjectList
            projects={rootSpaces}
            isLoading={isLoadingRoots}
            onOpenProject={openProject}
            onDeleteProject={handleDeleteProject}
            cloningProject={cloningProject}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      <RootProjectDialogs
        cloneOpen={cloneDialogOpen}
        createOpen={createDialogOpen}
        onCloneOpenChange={setCloneDialogOpen}
        onCloneProject={handleCloneProject}
        onCreateOpenChange={setCreateDialogOpen}
        onCreateProject={handleCreateProject}
      />
    </div>
  );
}

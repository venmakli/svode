import { useCallback } from "react";
import * as m from "@/paraglide/messages.js";
import { FolderPlus, FolderOpen, FolderGit2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ProjectLoadingLogo } from "@/features/branding";
import { useAppVersion } from "@/features/settings";
import { EmptyState } from "./empty-state";
import { RootProjectDialogs } from "./root-project-dialogs";
import { useCreateProjectShortcut } from "../hooks/use-create-project-shortcut";
import { useRootProjectWorkflow } from "../hooks/use-root-project-workflow";
import { useRootProjectWindowTitle } from "../hooks/use-root-project-window-title";

/** Home without projects: the start screen with the project actions. */
export function EmptyHome() {
  const version = useAppVersion();
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
    saveCloneAuthAndRetry,
    setCloneAuthOpen,
    setCloneDialogOpen,
    setCreateDialogOpen,
  } = useRootProjectWorkflow();
  const openCreateDialog = useCallback(
    () => setCreateDialogOpen(true),
    [setCreateDialogOpen],
  );

  useRootProjectWindowTitle();
  useCreateProjectShortcut(openCreateDialog);

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
            onClick={openCreateDialog}
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

        <EmptyState />
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
    </div>
  );
}

export function HomeBootstrapScreen() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <div data-tauri-drag-region className="h-[44px] w-full shrink-0" />
      <div className="flex flex-1 items-center justify-center">
        <ProjectLoadingLogo />
      </div>
    </div>
  );
}

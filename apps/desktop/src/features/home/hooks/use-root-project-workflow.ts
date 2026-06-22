import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { registerRootSpace, useSpace, useSpaceActions } from "@/features/space";
import {
  cloneRootProject,
  listenRootProjectCloneProgress,
  pickRootProjectFolder,
} from "../api/root-project-actions";
import { projectNameFromCloneUrl } from "../model/project-clone";
import type {
  CloneProjectSubmit,
  CloningProject,
  CreateProjectSubmit,
} from "../model/root-project";

interface UseRootProjectWorkflowInput {
  onRootOpened?: () => void;
}

function getErrorDescription(err: unknown): string | undefined {
  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "";

  return message.trim() || undefined;
}

export function useRootProjectWorkflow({
  onRootOpened,
}: UseRootProjectWorkflowInput = {}) {
  const navigate = useNavigate();
  const {
    rootSpaces,
    isLoadingRoots,
    loadRootSpaces,
    openRootFolder,
    explicitHome,
  } = useSpace();
  const { createRoot, deleteRoot, openLastActiveRoot, openRoot } =
    useSpaceActions();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [cloningProject, setCloningProject] =
    useState<CloningProject | null>(null);

  const enterRoot = useCallback(() => {
    onRootOpened?.();
    navigate({ to: "/space" });
  }, [navigate, onRootOpened]);

  const openProject = useCallback(
    async (id: string) => {
      if (await openRoot(id)) {
        enterRoot();
      }
    },
    [enterRoot, openRoot],
  );

  const openLastProject = useCallback(async () => {
    if (await openLastActiveRoot()) {
      enterRoot();
    }
  }, [enterRoot, openLastActiveRoot]);

  const initializeHome = useCallback(async () => {
    if (explicitHome) {
      await loadRootSpaces();
      return;
    }

    await openLastProject();
  }, [explicitHome, loadRootSpaces, openLastProject]);

  const handleCreateProject = useCallback<CreateProjectSubmit>(
    async (name, icon, description, path) => {
      try {
        const project = await createRoot(name, icon, description, path);
        setCreateDialogOpen(false);
        await openProject(project.id);
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("Project already exists")) {
          toast.info(m.home_project_already_exists());
          setCreateDialogOpen(false);
          try {
            const project = await openRootFolder(path);
            await openProject(project.id);
          } catch (openErr) {
            console.error("Failed to open existing project:", openErr);
            toast.error(m.home_open_project_error(), {
              description: getErrorDescription(openErr),
            });
          }
          return;
        }

        console.error("Failed to create project:", err);
        toast.error(m.toast_error(), {
          description: getErrorDescription(err),
        });
      }
    },
    [createRoot, openProject, openRootFolder],
  );

  const handleOpenProjectFolder = useCallback(async () => {
    const selected = await pickRootProjectFolder();
    if (!selected) return;
    try {
      const project = await openRootFolder(selected);
      await openProject(project.id);
    } catch (err) {
      console.error("Failed to open project folder:", err);
      toast.error(m.home_open_project_error(), {
        description: getErrorDescription(err),
      });
    }
  }, [openProject, openRootFolder]);

  const handleCloneProject = useCallback<CloneProjectSubmit>(
    async (url, targetPath) => {
      setCloneDialogOpen(false);

      setCloningProject({
        name: projectNameFromCloneUrl(url),
        path: targetPath,
        phase: "Starting",
        percent: 0,
      });

      let unlisten: (() => void) | undefined;

      try {
        unlisten = await listenRootProjectCloneProgress((progress) => {
          if (progress.spacePath !== targetPath) return;
          setCloningProject((prev) =>
            prev
              ? {
                  ...prev,
                  phase: progress.phase,
                  percent: progress.percent,
                }
              : prev,
          );
        });

        const project = await cloneRootProject(url, targetPath);
        setCloningProject(null);
        registerRootSpace(project);
        await openProject(project.id);
      } catch (err) {
        console.error("project_clone failed:", err);
        const message =
          typeof err === "string" ? err : ((err as Error)?.message ?? "error");
        setCloningProject((prev) =>
          prev
            ? { ...prev, phase: "Failed", percent: 0, error: message }
            : prev,
        );
        toast.error(m.git_clone_failed(), {
          description: getErrorDescription(err),
        });
        window.setTimeout(() => setCloningProject(null), 6000);
      } finally {
        unlisten?.();
      }
    },
    [openProject],
  );

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

  return {
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
  };
}

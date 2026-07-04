import { useCallback, useState } from "react";
import { useSpace } from "@/features/space";
import { useCloneRootProject } from "./use-clone-root-project";
import { useCreateRootProject } from "./use-create-root-project";
import { useDeleteRootProject } from "./use-delete-root-project";
import { useOpenRootProjectFolder } from "./use-open-root-project-folder";
import { useRootProjectNavigation } from "./use-root-project-navigation";

interface UseRootProjectWorkflowInput {
  onRootOpened?: () => void;
}

export function useRootProjectWorkflow({
  onRootOpened,
}: UseRootProjectWorkflowInput = {}) {
  const { rootSpaces, isLoadingRoots, loadRootSpaces, explicitHome } =
    useSpace();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const { openLastProject, openProject } = useRootProjectNavigation({
    onRootOpened,
  });

  const initializeHome = useCallback(async () => {
    if (explicitHome) {
      await loadRootSpaces();
      return;
    }

    const opened = await openLastProject();
    if (!opened) {
      await loadRootSpaces();
    }
  }, [explicitHome, loadRootSpaces, openLastProject]);
  const handleCreateProject = useCreateRootProject({
    openProject,
    setCreateDialogOpen,
  });
  const handleOpenProjectFolder = useOpenRootProjectFolder({ openProject });
  const { cloningProject, handleCloneProject } = useCloneRootProject({
    openProject,
    setCloneDialogOpen,
  });
  const handleDeleteProject = useDeleteRootProject();

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

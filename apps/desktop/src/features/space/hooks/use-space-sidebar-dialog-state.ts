import { useCallback, useState } from "react";

export type DeleteSpaceTarget = { id: string; name: string };

export function useSpaceSidebarDialogState() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteSpaceTarget | null>(
    null,
  );
  const [deleteFiles, setDeleteFiles] = useState(false);

  const resetDeleteDialog = useCallback(() => {
    setDeleteTarget(null);
    setDeleteFiles(false);
  }, []);

  return {
    createDialogOpen,
    deleteFiles,
    deleteTarget,
    resetDeleteDialog,
    setCreateDialogOpen,
    setDeleteFiles,
    setDeleteTarget,
  };
}

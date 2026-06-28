import { useCallback, useState } from "react";

export type DeleteSpaceTarget = { id: string; name: string };

export function useSpaceSidebarDialogState() {
  const [deleteTarget, setDeleteTarget] = useState<DeleteSpaceTarget | null>(
    null,
  );
  const [deleteFiles, setDeleteFiles] = useState(false);

  const resetDeleteDialog = useCallback(() => {
    setDeleteTarget(null);
    setDeleteFiles(false);
  }, []);

  return {
    deleteFiles,
    deleteTarget,
    resetDeleteDialog,
    setDeleteFiles,
    setDeleteTarget,
  };
}

import { useState } from "react";

export type DeleteSpaceTarget = { id: string; name: string };

export function useSpaceSidebarDialogState() {
  const [deleteTarget, setDeleteTarget] = useState<DeleteSpaceTarget | null>(
    null,
  );

  return {
    deleteTarget,
    setDeleteTarget,
  };
}

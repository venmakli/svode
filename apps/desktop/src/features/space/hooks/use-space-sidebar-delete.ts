import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";

interface UseSpaceSidebarDeleteInput {
  activeRootPath: string | null;
  deleteFiles: boolean;
  deleteSpace: (
    parentPath: string,
    spaceId: string,
    deleteFiles?: boolean,
  ) => Promise<void>;
  resetDeleteDialog: () => void;
}

export function useSpaceSidebarDelete({
  activeRootPath,
  deleteFiles,
  deleteSpace,
  resetDeleteDialog,
}: UseSpaceSidebarDeleteInput) {
  return useCallback(
    async (spaceId: string) => {
      if (!activeRootPath) return;

      try {
        await deleteSpace(activeRootPath, spaceId, deleteFiles);
      } catch (err) {
        console.error("Failed to delete space:", err);
        toast.error(m.toast_error());
      }
      resetDeleteDialog();
    },
    [activeRootPath, deleteFiles, deleteSpace, resetDeleteDialog],
  );
}

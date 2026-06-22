import { useCallback } from "react";
import { useSpaceActions } from "@/features/space";

export function useDeleteRootProject() {
  const { deleteRoot } = useSpaceActions();

  return useCallback(
    async (id: string, deleteFiles: boolean) => {
      try {
        await deleteRoot(id, deleteFiles);
      } catch (err) {
        console.error("Failed to delete project:", err);
      }
    },
    [deleteRoot],
  );
}

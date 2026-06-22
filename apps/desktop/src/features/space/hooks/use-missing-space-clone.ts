import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { trackSpaceCloneProgress } from "@/features/git";
import {
  cloneMissingSpace,
  removeMissingSpace,
} from "../api/space-actions";

export function useMissingSpaceClone(
  rootPath: string | null,
  loadSpaces: (rootPath: string) => Promise<void>,
) {
  const handleCloneMissing = useCallback(
    async (spaceId: string, spacePath: string) => {
      if (!rootPath) return;

      let progress: Awaited<ReturnType<typeof trackSpaceCloneProgress>> | null =
        null;
      try {
        progress = await trackSpaceCloneProgress(spacePath);
        await cloneMissingSpace({ projectPath: rootPath, spaceId });
        await loadSpaces(rootPath);
        progress.complete();
      } catch (err) {
        console.error("clone_missing_space failed:", err);
        const message =
          typeof err === "string" ? err : ((err as Error)?.message ?? "error");
        progress?.fail(message);
        toast.error(m.git_clone_failed());
      } finally {
        progress?.dispose();
      }
    },
    [loadSpaces, rootPath],
  );

  const handleRemoveBroken = useCallback(
    async (spaceId: string) => {
      if (!rootPath) return;

      try {
        await removeMissingSpace({ projectPath: rootPath, spaceId });
        await loadSpaces(rootPath);
      } catch (err) {
        console.error("remove_missing_space failed:", err);
        toast.error(m.toast_error());
      }
    },
    [loadSpaces, rootPath],
  );

  return {
    handleCloneMissing,
    handleRemoveBroken,
  };
}

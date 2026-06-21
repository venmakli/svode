import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { setSpaceCloneProgress } from "@/features/git/sidebar";
import {
  cloneMissingSpace,
  listenSpaceCloneProgress,
  removeMissingSpace,
} from "../api/space-actions";

export function useMissingSpaceClone(
  rootPath: string | null,
  loadSpaces: (rootPath: string) => Promise<void>,
) {
  const handleCloneMissing = useCallback(
    async (spaceId: string, spacePath: string) => {
      if (!rootPath) return;

      setSpaceCloneProgress(spacePath, { phase: "Starting", percent: 0 });

      const unlisten = await listenSpaceCloneProgress((progress) => {
        if (progress.spacePath !== spacePath) return;
        setSpaceCloneProgress(spacePath, {
          phase: progress.phase,
          percent: progress.percent,
        });
      });

      try {
        await cloneMissingSpace({ projectPath: rootPath, spaceId });
        await loadSpaces(rootPath);
        setSpaceCloneProgress(spacePath, null);
      } catch (err) {
        console.error("clone_missing_space failed:", err);
        const message =
          typeof err === "string" ? err : ((err as Error)?.message ?? "error");
        setSpaceCloneProgress(spacePath, {
          phase: m.git_clone_failed(),
          percent: 0,
          error: message,
        });
        toast.error(m.git_clone_failed());
        window.setTimeout(
          () => setSpaceCloneProgress(spacePath, null),
          6000,
        );
      } finally {
        unlisten();
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

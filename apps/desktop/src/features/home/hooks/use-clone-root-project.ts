import { useCallback, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { registerRootSpace } from "@/features/space";
import {
  cloneRootProject,
  listenRootProjectCloneProgress,
} from "../api/root-project-actions";
import { getRootProjectErrorDescription } from "../lib/root-project-errors";
import { projectNameFromCloneUrl } from "../model/project-clone";
import type { CloneProjectSubmit, CloningProject } from "../model/root-project";

interface UseCloneRootProjectInput {
  openProject: (id: string) => Promise<void>;
  setCloneDialogOpen: (open: boolean) => void;
}

export function useCloneRootProject({
  openProject,
  setCloneDialogOpen,
}: UseCloneRootProjectInput) {
  const [cloningProject, setCloningProject] = useState<CloningProject | null>(
    null,
  );

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
          description: getRootProjectErrorDescription(err),
        });
        window.setTimeout(() => setCloningProject(null), 6000);
      } finally {
        unlisten?.();
      }
    },
    [openProject, setCloneDialogOpen],
  );

  return {
    cloningProject,
    handleCloneProject,
  };
}

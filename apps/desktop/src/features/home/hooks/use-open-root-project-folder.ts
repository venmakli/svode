import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useSpace } from "@/features/space";
import { pickRootProjectFolder } from "../api/root-project-actions";
import { getRootProjectErrorDescription } from "../lib/root-project-errors";

interface UseOpenRootProjectFolderInput {
  openProject: (id: string) => Promise<void>;
}

export function useOpenRootProjectFolder({
  openProject,
}: UseOpenRootProjectFolderInput) {
  const { openRootFolder } = useSpace();

  return useCallback(async () => {
    const selected = await pickRootProjectFolder();
    if (!selected) return;
    try {
      const project = await openRootFolder(selected);
      await openProject(project.id);
    } catch (err) {
      console.error("Failed to open project folder:", err);
      toast.error(m.home_open_project_error(), {
        description: getRootProjectErrorDescription(err),
      });
    }
  }, [openProject, openRootFolder]);
}

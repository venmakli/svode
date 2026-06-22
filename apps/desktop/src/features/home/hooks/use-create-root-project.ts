import { useCallback } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useSpace, useSpaceActions } from "@/features/space";
import { getRootProjectErrorDescription } from "../lib/root-project-errors";
import type { CreateProjectSubmit } from "../model/root-project";

interface UseCreateRootProjectInput {
  openProject: (id: string) => Promise<void>;
  setCreateDialogOpen: (open: boolean) => void;
}

export function useCreateRootProject({
  openProject,
  setCreateDialogOpen,
}: UseCreateRootProjectInput): CreateProjectSubmit {
  const { openRootFolder } = useSpace();
  const { createRoot } = useSpaceActions();

  return useCallback<CreateProjectSubmit>(
    async (name, icon, description, path) => {
      try {
        const project = await createRoot(name, icon, description, path);
        setCreateDialogOpen(false);
        await openProject(project.id);
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("Project already exists")) {
          toast.info(m.home_project_already_exists());
          setCreateDialogOpen(false);
          try {
            const project = await openRootFolder(path);
            await openProject(project.id);
          } catch (openErr) {
            console.error("Failed to open existing project:", openErr);
            toast.error(m.home_open_project_error(), {
              description: getRootProjectErrorDescription(openErr),
            });
          }
          return;
        }

        console.error("Failed to create project:", err);
        toast.error(m.toast_error(), {
          description: getRootProjectErrorDescription(err),
        });
      }
    },
    [createRoot, openProject, openRootFolder, setCreateDialogOpen],
  );
}

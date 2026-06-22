import { CloneProjectDialog } from "./clone-project-dialog";
import { CreateProjectDialog } from "./create-project-dialog";
import type {
  CloneProjectSubmit,
  CreateProjectSubmit,
} from "../model/root-project";

interface RootProjectDialogsProps {
  cloneOpen: boolean;
  createOpen: boolean;
  onCloneOpenChange: (open: boolean) => void;
  onCloneProject: CloneProjectSubmit;
  onCreateOpenChange: (open: boolean) => void;
  onCreateProject: CreateProjectSubmit;
}

export function RootProjectDialogs({
  cloneOpen,
  createOpen,
  onCloneOpenChange,
  onCloneProject,
  onCreateOpenChange,
  onCreateProject,
}: RootProjectDialogsProps) {
  return (
    <>
      <CreateProjectDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        onSubmit={onCreateProject}
      />
      <CloneProjectDialog
        open={cloneOpen}
        onOpenChange={onCloneOpenChange}
        onSubmit={onCloneProject}
      />
    </>
  );
}

import { CloneProjectDialog } from "./clone-project-dialog";
import { CreateProjectDialog } from "./create-project-dialog";
import {
  GitRemoteAuthDialog,
  type GitAuthChallenge,
  type GitRemoteAuthCredentials,
} from "@/features/git";
import type {
  CloneProjectSubmit,
  CreateProjectSubmit,
} from "../model/root-project";

interface RootProjectDialogsProps {
  cloneAuthChallenge: GitAuthChallenge | null;
  cloneAuthError: string | null;
  cloneAuthOpen: boolean;
  cloneAuthSaving: boolean;
  cloneOpen: boolean;
  createOpen: boolean;
  onCloneAuthOpenChange: (open: boolean) => void;
  onCloneAuthSaveAndRetry: (
    credentials: GitRemoteAuthCredentials,
  ) => Promise<void>;
  onCloneOpenChange: (open: boolean) => void;
  onCloneProject: CloneProjectSubmit;
  onCreateOpenChange: (open: boolean) => void;
  onCreateProject: CreateProjectSubmit;
}

export function RootProjectDialogs({
  cloneAuthChallenge,
  cloneAuthError,
  cloneAuthOpen,
  cloneAuthSaving,
  cloneOpen,
  createOpen,
  onCloneAuthOpenChange,
  onCloneAuthSaveAndRetry,
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
      <GitRemoteAuthDialog
        open={cloneAuthOpen}
        challenge={cloneAuthChallenge}
        saving={cloneAuthSaving}
        error={cloneAuthError}
        onOpenChange={onCloneAuthOpenChange}
        onSaveAndRetry={onCloneAuthSaveAndRetry}
      />
    </>
  );
}

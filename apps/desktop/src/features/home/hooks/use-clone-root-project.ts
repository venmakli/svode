import { useCallback, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  gitAuthChallengeFromRemoteUrl,
  isGitAuthRequiredError,
  saveGitRemoteCredentials,
  type GitAuthChallenge,
  type GitRemoteAuthCredentials,
} from "@/features/git";
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

interface PendingCloneProject {
  url: string;
  targetPath: string;
}

export function useCloneRootProject({
  openProject,
  setCloneDialogOpen,
}: UseCloneRootProjectInput) {
  const [cloningProject, setCloningProject] = useState<CloningProject | null>(
    null,
  );
  const [authChallenge, setAuthChallenge] = useState<GitAuthChallenge | null>(
    null,
  );
  const [authOpen, setAuthOpen] = useState(false);
  const [authSaving, setAuthSaving] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingClone, setPendingClone] = useState<PendingCloneProject | null>(
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
        if (isGitAuthRequiredError(err)) {
          setCloningProject(null);
          setPendingClone({ url, targetPath });
          setAuthChallenge(
            gitAuthChallengeFromRemoteUrl({
              remoteUrl: url,
              operation: "clone",
              detail:
                typeof err === "string"
                  ? err
                  : ((err as Error)?.message ?? null),
            }),
          );
          setAuthError(null);
          setAuthOpen(true);
          return;
        }

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

  const setAuthDialogOpen = useCallback((open: boolean) => {
    setAuthOpen(open);
    if (!open) {
      setAuthError(null);
      setAuthChallenge(null);
      setPendingClone(null);
    }
  }, []);

  const saveAuthAndRetry = useCallback(
    async (credentials: GitRemoteAuthCredentials) => {
      if (!authChallenge?.remoteUrl || !pendingClone || authSaving) return;
      setAuthSaving(true);
      setAuthError(null);
      try {
        await saveGitRemoteCredentials({
          remoteUrl: authChallenge.remoteUrl,
          username: credentials.username,
          password: credentials.password,
        });
        setAuthOpen(false);
        setAuthChallenge(null);
        setPendingClone(null);
        await handleCloneProject(pendingClone.url, pendingClone.targetPath);
      } catch (err) {
        console.error("project clone credential save failed:", err);
        setAuthError(m.git_remote_auth_save_failed());
      } finally {
        setAuthSaving(false);
      }
    },
    [authChallenge, authSaving, handleCloneProject, pendingClone],
  );

  return {
    authChallenge,
    authError,
    authOpen,
    authSaving,
    cloningProject,
    handleCloneProject,
    saveAuthAndRetry,
    setAuthDialogOpen,
  };
}

import { listenCloneProgress } from "@/platform/git/git-api";
import type { CloneProgressDto } from "@/platform/git/git-types";
import { useGitStore, type GitCloneProgress } from "../model";

export interface GitCloneProgressTracker {
  complete: () => void;
  fail: (message: string) => void;
  dispose: () => void;
}

function setSpaceCloneProgress(
  spacePath: string,
  progress: GitCloneProgress | null,
): void {
  useGitStore.getState().setCloning(spacePath, progress);
}

function toGitCloneProgress(progress: CloneProgressDto): GitCloneProgress {
  return {
    status: "progress",
    phase: progress.phase,
    percent: progress.percent,
  };
}

export async function trackSpaceCloneProgress(
  spacePath: string,
): Promise<GitCloneProgressTracker> {
  let disposed = false;
  setSpaceCloneProgress(spacePath, {
    status: "starting",
    phase: null,
    percent: 0,
  });

  const unlisten = await listenCloneProgress((progress) => {
    if (disposed) return;
    if (progress.spacePath !== spacePath) return;
    setSpaceCloneProgress(spacePath, toGitCloneProgress(progress));
  });

  return {
    complete: () => setSpaceCloneProgress(spacePath, null),
    fail: (message) => {
      setSpaceCloneProgress(spacePath, {
        status: "failed",
        phase: null,
        percent: 0,
        error: message,
      });
      window.setTimeout(() => setSpaceCloneProgress(spacePath, null), 6000);
    },
    dispose: () => {
      disposed = true;
      unlisten();
    },
  };
}

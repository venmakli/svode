import { useCallback } from "react";
import { commitAllSpace } from "../api/git-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import { useGitStore, type GitCloneProgress } from "../model";
import { useGitWatch } from "./use-git-watch";

export type SpaceSidebarGitCloneProgress = GitCloneProgress;

export interface SpaceSidebarGitState {
  cloning: SpaceSidebarGitCloneProgress | undefined;
  dirty: boolean;
  commitAll: () => void;
}

export function useSpaceSidebarGit(
  spacePath: string,
  projectPath: string,
): SpaceSidebarGitState {
  useGitWatch(spacePath);

  const cloning = useGitStore((state) => state.cloning[spacePath]);
  const dirty = useGitStore((state) => {
    const status = state.statuses[spacePath];
    return !!(status?.hasStaged || status?.hasUnstaged);
  });
  const commitAll = useCallback(() => {
    void commitAllSpace(spacePath, projectPath, {
      onSyncOutcome: notifyGitSyncOutcome,
    });
  }, [projectPath, spacePath]);

  return {
    cloning,
    dirty,
    commitAll,
  };
}

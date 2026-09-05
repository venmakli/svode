import { useCallback, useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { useRepositoryAccessPreflight } from "./use-repository-access-preflight";
import { commitAllSpace } from "../api/git-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import { useGitStore, type GitCloneProgress } from "../model";
import { useGitWatch } from "./use-git-watch";

export type SpaceSidebarGitCloneProgress = GitCloneProgress;

export interface SpaceSidebarGitState {
  cloning: SpaceSidebarGitCloneProgress | undefined;
  dirty: boolean;
  commitAll: () => void;
  recovery: ReturnType<typeof useRepositoryAccessPreflight>;
}

export function useSpaceSidebarGit(
  spacePath: string,
  projectPath: string,
): SpaceSidebarGitState {
  useGitWatch(spacePath);
  const recovery = useRepositoryAccessPreflight();
  const [pending, setPending] = useState(false);

  const cloning = useGitStore((state) => state.cloning[spacePath]);
  const statusDirty = useGitStore((state) => {
    const status = state.statuses[spacePath];
    return !!(status?.hasStaged || status?.hasUnstaged);
  });
  const commitAll = useCallback(() => {
    const run = async () => {
      try {
        await commitAllSpace(spacePath, projectPath, {
          onSyncOutcome: notifyGitSyncOutcome,
        });
        setPending(false);
      } catch (error) {
        setPending(true);
        const partial = Boolean(
          error &&
          typeof error === "object" &&
          "kind" in error &&
          error.kind === "git_save_partial",
        );
        const cause =
          partial && error && typeof error === "object" && "cause" in error
            ? error.cause
            : error;
        const handled = await recovery.recoverFromError(cause, {
          intentKey: `space-save:${spacePath}`,
          intentLabel: m.git_save_all(),
          placement: "dialog",
          continuation: "explicit",
          targets: [
            {
              displayName: m.git_save_all(),
              displayPath: spacePath,
              repositoryPath: partial ? projectPath : spacePath,
            },
          ],
          continue: run,
        });
        if (!handled)
          toast.error(partial ? m.changes_partial() : m.changes_save_failed(), {
            action: { label: m.changes_retry(), onClick: () => void run() },
          });
      }
    };
    void run();
  }, [projectPath, recovery, spacePath]);

  return {
    cloning,
    dirty: statusDirty || pending,
    commitAll,
    recovery,
  };
}

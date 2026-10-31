import { useCallback, useEffect, useRef, useState } from "react";
import { mergeGitServiceFiles, syncGitPointerSpace } from "../api/git-actions";
import { notifyGitSyncOutcome } from "../effects/git-notifications";
import type { GitSyncOutcome } from "../model";
import * as m from "@/paraglide/messages.js";

/** The service-file action of a merge stop that is running. */
export type GitServiceMergeRunning =
  | { kind: "merge" }
  | { kind: "space"; path: string }
  | null;

export interface GitServiceMerge {
  running: GitServiceMergeRunning;
  /** Why the last action did not finish, until the next one. */
  error: string | null;
  /** «Слить служебные файлы Svode». */
  mergeAll: () => Promise<void>;
  /** «Синхронизировать пространство» for the pointer at `path`. */
  syncSpace: (path: string) => Promise<void>;
}

/**
 * The service-file actions of the merge stop of the repository at
 * `repositoryPath`; an error stays only while that stop does.
 */
export function useGitServiceMerge(
  repositoryPath: string,
  stopped: boolean,
): GitServiceMerge {
  const active = useRef<object | null>(null);
  const [running, setRunning] = useState<GitServiceMergeRunning>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = {};
    setRunning(null);
    setError(null);
    return () => {
      active.current = null;
    };
  }, [repositoryPath]);
  useEffect(() => {
    if (!stopped) setError(null);
  }, [stopped]);

  const run = useCallback(
    async (
      next: Exclude<GitServiceMergeRunning, null>,
      action: () => Promise<string | null>,
    ) => {
      const identity = active.current;
      setRunning(next);
      setError(null);
      try {
        const failure = await action();
        if (active.current === identity) setError(failure);
      } finally {
        if (active.current === identity) setRunning(null);
      }
    },
    [],
  );

  const mergeAll = useCallback(async () => {
    if (!repositoryPath) return;
    await run({ kind: "merge" }, async () =>
      projectFailure(await mergeGitServiceFiles(repositoryPath)),
    );
  }, [repositoryPath, run]);

  const syncSpace = useCallback(
    async (path: string) => {
      if (!repositoryPath) return;
      await run({ kind: "space", path }, async () => {
        const { space, project } = await syncGitPointerSpace(
          repositoryPath,
          path,
        );
        if (project) return projectFailure(project);
        return space.type === "Failed"
          ? space.message
          : m.git_sync_service_space_not_synced();
      });
    },
    [repositoryPath, run],
  );

  return { running, error, mergeAll, syncSpace };
}

/** The message of a failed project step; other outcomes are announced. */
function projectFailure(outcome: GitSyncOutcome): string | null {
  if (outcome.type === "Failed" && !outcome.block && !outcome.stop)
    return outcome.message;
  notifyGitSyncOutcome(outcome);
  return null;
}

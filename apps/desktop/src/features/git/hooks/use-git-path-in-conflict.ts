import { useGitStore } from "../model/git-store";
import { gitStatusPathInConflict } from "../model/git-status-index";

/** Whether `path` (relative to `spacePath`) is in conflict in its status. */
export function useGitPathInConflict(spacePath: string, path: string): boolean {
  return useGitStore((state) =>
    gitStatusPathInConflict(state.statuses[spacePath], path),
  );
}

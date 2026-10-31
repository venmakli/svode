import { useGitStore } from "../model/git-store";
import { normalizeGitStatusPath } from "../model/git-paths";

/** Whether `path` (relative to `spacePath`) is in conflict in its status. */
export function useGitPathInConflict(spacePath: string, path: string): boolean {
  const target = normalizeGitStatusPath(path);
  return useGitStore(
    (state) =>
      state.statuses[spacePath]?.files.some(
        (file) =>
          file.state === "conflict" &&
          normalizeGitStatusPath(file.path) === target,
      ) ?? false,
  );
}

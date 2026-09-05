import type { FileGitState } from "@/features/git";
import type { InspectionItemStats } from "../api/inspection";

export type ChangesFilter = "all" | FileGitState;

export function filterChanges(
  paths: string[],
  files: ReadonlyMap<string, { state: FileGitState }>,
  filter: ChangesFilter,
) {
  const counts: Record<ChangesFilter, number> = {
    all: paths.length,
    modified: 0,
    deleted: 0,
    untracked: 0,
    conflict: 0,
  };
  const filtered = paths.filter((path) => {
    const state = files.get(path)?.state;
    if (state) counts[state]++;
    return filter === "all" || state === filter;
  });
  return { paths: filtered, counts };
}

export function summarizeChanges(
  paths: string[],
  stats: Readonly<Record<string, InspectionItemStats>>,
) {
  let additions = 0;
  let deletions = 0;
  let counted = 0;
  let pending = 0;
  for (const path of paths) {
    const item = stats[path];
    if (!item) pending++;
    else if (item.additions !== null && item.deletions !== null) {
      additions += item.additions;
      deletions += item.deletions;
      counted++;
    }
  }
  return { additions, deletions, counted, pending, total: paths.length };
}

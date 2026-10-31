import {
  closeGitVersionGroups,
  listenGitAutoVersion,
} from "@/platform/git/git-api";
import { toGitSaveFailureDto } from "@/platform/git/save-errors";
import { useGitStore, type GitSyncStop } from "../model";
import { gitBranchErrorMessage } from "./git-branch-error";

/** Keep the commit stop of each repository in step with its automatic versions. */
export function listenAutoVersionOutcomes() {
  return listenGitAutoVersion(recordAutoVersionOutcome);
}

export function recordAutoVersionOutcome(event: {
  repository: string;
  error: unknown;
}) {
  const git = useGitStore.getState();
  if (event.error) {
    const stop: GitSyncStop = {
      kind: "commit",
      cause: toGitSaveFailureDto(event.error),
      branchMessage: gitBranchErrorMessage(event.error),
    };
    git.setSyncStop(event.repository, stop);
    return;
  }
  const current =
    git.syncStop[
      git.statuses[event.repository]?.repository ?? event.repository
    ];
  if (current?.kind === "commit") git.setSyncStop(event.repository, null);
}

/** The user left the Page or Collection at `path` of the Space. */
export function closeLeftVersionGroup(
  spacePath: string,
  path: string,
): Promise<void> {
  return closeGitVersionGroups({ spacePaths: [spacePath], left: path });
}

/** The window lost focus: every open group of these Spaces closes. */
export function closeAllVersionGroups(spacePaths: string[]): Promise<void> {
  return closeGitVersionGroups({ spacePaths });
}

import { pushGit } from "@/platform/git/git-api";
import { useGitStore } from "../model";
import { isAutoSyncEnabled, syncOnOpen } from "./git-actions";
import { toGitStatus } from "./git-mappers";
import { getGitStatusSnapshot } from "./git-status-actions";

export function syncGitOnActiveSpaceOpen(spacePath: string): Promise<void> {
  return syncOnOpen(spacePath);
}

export async function refreshGitOnWindowFocus(spacePath: string): Promise<void> {
  try {
    const status = await getGitStatusSnapshot(spacePath);
    useGitStore.getState().applyStatus(spacePath, status);
    if (
      (await isAutoSyncEnabled(spacePath)) &&
      status.ahead > 0 &&
      status.tracking
    ) {
      try {
        const pushed = toGitStatus(await pushGit(spacePath));
        useGitStore.getState().applyStatus(spacePath, pushed);
      } catch (err) {
        console.debug("auto-push on focus failed:", err);
      }
    }
  } catch (err) {
    console.debug("git_status on focus failed:", err);
  }
}

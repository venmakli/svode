import { useGitStore } from "../model";
import { isAutoSyncEnabled, syncOnOpen, syncSpace } from "./git-actions";
import { refreshGitRemoteStatus } from "./git-status-actions";

export function syncGitOnActiveSpaceOpen(spacePath: string): Promise<void> {
  return syncOnOpen(spacePath);
}

export async function refreshGitOnWindowFocus(
  spacePath: string,
): Promise<void> {
  try {
    const status = await refreshGitRemoteStatus(spacePath);
    if (
      (await isAutoSyncEnabled(spacePath)) &&
      (status.ahead > 0 || status.behind > 0)
    ) {
      await syncSpace(spacePath);
    }
  } catch (err) {
    useGitStore.getState().setSyncError(spacePath, String(err));
    console.debug("git fetch/status on focus failed:", err);
  }
}

import { useGitStore } from "../model";
import { isAutoSyncEnabled, syncOnOpen, syncSpace } from "./git-actions";
import { refreshGitRemoteStatus } from "./git-status-actions";

export function syncGitOnActiveSpaceOpen(
  spacePath: string,
  projectPath?: string | null,
): Promise<void> {
  return syncOnOpen(spacePath, projectPath);
}

export async function refreshGitOnWindowFocus(
  spacePath: string,
  projectPath?: string | null,
): Promise<void> {
  try {
    const status = await refreshGitRemoteStatus(spacePath);
    if (
      (await isAutoSyncEnabled(spacePath, projectPath)) &&
      (status.ahead > 0 || status.behind > 0)
    ) {
      await syncSpace(spacePath);
    }
  } catch (err) {
    useGitStore.getState().setSyncError(spacePath, String(err));
    console.debug("git fetch/status on focus failed:", err);
  }
}

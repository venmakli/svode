import { triggerGitSync } from "@/platform/git/git-api";
import { useGitStore } from "../model";
import { toGitStatus } from "./git-mappers";

/**
 * A Space opened, also at start: with sync on, the rhythm checks incoming
 * (Stage 11 1.E). Silent on failure.
 */
export async function syncGitOnActiveSpaceOpen(
  spacePath: string,
): Promise<void> {
  try {
    await triggerGitSync({ spacePath, trigger: "opened" });
  } catch (err) {
    console.debug("git sync on open not planned:", err);
  }
}

/**
 * The window got focus: with sync on, the rhythm checks incoming; with sync
 * off, the counters come from a fetch that starts with the light check.
 */
export async function refreshGitOnWindowFocus(
  spacePath: string,
): Promise<void> {
  try {
    const status = await triggerGitSync({ spacePath, trigger: "focused" });
    if (status)
      useGitStore.getState().applyRemoteStatus(spacePath, toGitStatus(status));
  } catch (err) {
    console.debug("git fetch/status on focus failed:", err);
  }
}

import { getGitConflictMarkerSize } from "@/platform/git/git-api";

import {
  DEFAULT_CONFLICT_MARKER_SIZE,
  hasConflictMarkerCandidate,
} from "../conflict/conflict-markers";

/**
 * Conflict marker size for parsing `body` of the Page at `path`. Git is asked
 * only for a body with a line that could open a block; an unreadable size
 * falls back to Git's default.
 */
export async function readConflictMarkerSize(
  spacePath: string,
  path: string,
  body: string,
): Promise<number> {
  if (!hasConflictMarkerCandidate(body)) return DEFAULT_CONFLICT_MARKER_SIZE;
  try {
    return await getGitConflictMarkerSize({ spacePath, path });
  } catch (error) {
    console.error("Failed to read the conflict marker size:", error);
    return DEFAULT_CONFLICT_MARKER_SIZE;
  }
}

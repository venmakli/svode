import {
  getGitConflictMarkerSize,
  getPageConflictBases,
} from "@/platform/git/git-api";

import {
  DEFAULT_CONFLICT_MARKER_SIZE,
  findConflictBlocks,
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

/**
 * The base of each conflict block of `content`, the text the editor parses
 * for the Page at `path` with markers of `markerSize`, in the order of the
 * blocks; `null` for a block without one. Git is asked only when `content`
 * has a block; bases that do not read leave every block without one.
 */
export async function readConflictBases(
  spacePath: string,
  path: string,
  content: string,
  markerSize: number,
): Promise<(string | null)[]> {
  if (!hasConflictMarkerCandidate(content)) return [];
  if (findConflictBlocks(content, markerSize).length === 0) return [];
  try {
    return await getPageConflictBases({
      spacePath,
      path,
      content,
      markerSize,
    });
  } catch (error) {
    console.error("Failed to read the conflict bases:", error);
    return [];
  }
}

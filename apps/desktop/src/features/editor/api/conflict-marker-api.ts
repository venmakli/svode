import { readPageMerge, type Page, type PageMerge } from "@/features/page";
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

/**
 * The merge of the properties of the Page at `path` whose `body` has a line
 * that could open a conflict block: Svode tells whether a conflict place lies
 * in its frontmatter (DF-292, DF-293 R6), also a place from the first line,
 * with which the Page reads as one without frontmatter. `null` when none
 * does or the merge does not read.
 */
async function readConflictMerge(
  spacePath: string,
  path: string,
  body: string,
): Promise<PageMerge | null> {
  if (!hasConflictMarkerCandidate(body)) return null;
  try {
    return await readPageMerge(spacePath, path);
  } catch (error) {
    console.error("Failed to read the merge of the Page properties:", error);
    return null;
  }
}

/**
 * The conflicts of the Page `page` read at `path`: the conflict marker size,
 * the merge of its properties when its frontmatter is in conflict (DF-292),
 * the text the editor gets — the text below the properties merged as text,
 * none without a choice by properties — and the base of each of its blocks.
 */
export async function readPageConflicts(
  spacePath: string,
  path: string,
  page: Pick<Page, "body">,
): Promise<{
  markerSize: number;
  merge: PageMerge | null;
  text: string;
  bases: (string | null)[];
}> {
  const markerSize = await readConflictMarkerSize(spacePath, path, page.body);
  const merge = await readConflictMerge(spacePath, path, page.body);
  const text = !merge ? page.body : merge.type === "merged" ? merge.body : "";
  const bases = await readConflictBases(spacePath, path, text, markerSize);
  return { markerSize, merge, text, bases };
}

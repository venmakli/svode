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
 * Marker lines in the frontmatter keep it from reading: the whole file comes
 * as the body with a warning.
 */
function frontmatterInConflict(page: Pick<Page, "body" | "warnings">) {
  return (
    hasConflictMarkerCandidate(page.body) &&
    Boolean(
      page.warnings?.some(
        (warning) => warning.kind === "malformed_frontmatter",
      ),
    )
  );
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
  page: Pick<Page, "body" | "warnings">,
): Promise<{
  markerSize: number;
  merge: PageMerge | null;
  text: string;
  bases: (string | null)[];
}> {
  const markerSize = await readConflictMarkerSize(spacePath, path, page.body);
  const merge = frontmatterInConflict(page)
    ? await readPageMerge(spacePath, path)
    : null;
  const text = !merge ? page.body : merge.type === "merged" ? merge.body : "";
  const bases = await readConflictBases(spacePath, path, text, markerSize);
  return { markerSize, merge, text, bases };
}

import type { GitResolutionFinding } from "@/features/git";
import { composePageMerge, getPageMerge } from "@/platform/git/git-api";

import type {
  PageMerge,
  PageMergeDecision,
  PageMergeState,
} from "../model/page-merge";

/**
 * The Page at `path` (relative to `spacePath`) whose frontmatter is in
 * conflict, merged by its properties from the index stages (DF-292).
 */
export async function readPageMerge(
  spacePath: string,
  path: string,
): Promise<PageMerge> {
  const dto = await getPageMerge({ spacePath, path });
  if (dto.type === "unavailable") return dto;
  return {
    type: "merged",
    body: dto.body,
    properties: dto.properties.map((property) => ({
      key: property.key,
      base: property.base,
      ours: property.ours,
      theirs: property.theirs,
      disputed: property.disputed,
      merged: property.merged,
    })),
  };
}

/**
 * The Page at `path` composed from the decisions of `state` and the text
 * `body` below its properties, as the writer of Page frontmatter writes it;
 * nothing is written.
 */
export async function composeDecidedPage(
  spacePath: string,
  path: string,
  state: PageMergeState,
  body: string,
): Promise<
  | { type: "composed"; content: string }
  | { type: "unresolved"; finding: GitResolutionFinding }
> {
  const decisions: Record<string, PageMergeDecision> = { ...state.decisions };
  return composePageMerge({ spacePath, path, decisions, body });
}

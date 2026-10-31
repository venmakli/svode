import { getGitUncommittedGroups } from "@/platform/git/git-api";
import type { GitUncommittedGroupsDto } from "@/platform/git/git-types";
import type { AreaPart } from "../model/agent-commit-request";

/**
 * The uncommitted groups of every part of an area with their facts, in
 * the parts' order; nothing is staged (Stage 11 1.10).
 */
export function loadUncommittedGroups(
  parts: readonly AreaPart[],
): Promise<GitUncommittedGroupsDto[]> {
  return Promise.all(
    parts
      .filter((part) => part.paths.length > 0)
      .map((part) =>
        getGitUncommittedGroups({
          spacePath: part.spacePath,
          paths: part.paths,
        }),
      ),
  );
}

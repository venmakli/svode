import { getSpaceSnapshot } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import type { RepositoryAccessBlocker } from "../model/repository-access";
import {
  repositoryOwner,
  type RepositoryOwnerContext,
} from "../model/repository-owner";

const NAMED_BLOCKERS = 3;

/**
 * Names the repositories that refused a write by their Project or Space
 * owner, at most three and a count of the rest, for a one-line notice.
 */
export function repositoryBlockerNames(
  blockers: readonly RepositoryAccessBlocker[],
  context: RepositoryOwnerContext = activeOwnerContext(),
): string {
  const named = blockers
    .slice(0, NAMED_BLOCKERS)
    .map(
      (blocker) => repositoryOwner(blocker.repositoryPath, context).displayName,
    )
    .join(", ");
  const hidden = blockers.length - NAMED_BLOCKERS;
  return hidden > 0
    ? `${named} ${m.git_access_blockers_more({ count: hidden })}`
    : named;
}

function activeOwnerContext(): RepositoryOwnerContext {
  const space = getSpaceSnapshot();
  return {
    projectName: space.activeRootName,
    projectPath: space.activeRootPath,
    spaces: space.spaces,
  };
}

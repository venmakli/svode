import { getSpaceSnapshot } from "@/features/space";
import * as m from "@/paraglide/messages.js";

import type { RepositoryAccessBlocker } from "../model/repository-access";
import {
  repositoryOwner,
  repositorySettingsOpener,
  type RepositoryOwnerContext,
} from "../model/repository-owner";
import { repositoryAccessPresentation } from "./repository-access-copy";

const NAMED_BLOCKERS = 3;

export interface RepositoryBlockersNotice {
  /** Owners of the refusing repositories with their access state. */
  repositories: string;
  /** Opens the Git settings of the only blocker, or of the project. */
  settingsAction?: { label: string; onClick: () => void };
}

/**
 * Names the repositories that refused a write by their Project or Space
 * owner, for a notice outside the recovery surface.
 */
export function repositoryBlockersNotice(
  blockers: readonly RepositoryAccessBlocker[],
  context: RepositoryOwnerContext = activeOwnerContext(),
): RepositoryBlockersNotice {
  const owners = blockers.map((blocker) => ({
    blocker,
    owner: repositoryOwner(blocker.repositoryPath, context),
  }));
  const named = owners
    .slice(0, NAMED_BLOCKERS)
    .map(({ blocker, owner }) =>
      m.git_access_blocker_item({
        name: owner.displayName,
        status: blockerStatusLabel(blocker),
      }),
    )
    .join(", ");
  const hidden = owners.length - NAMED_BLOCKERS;
  const openSettings = repositorySettingsOpener(
    owners.length === 1 ? owners[0].owner.settingsPath : context.projectPath,
  );
  return {
    repositories:
      hidden > 0
        ? `${named} ${m.git_access_blockers_more({ count: hidden })}`
        : named,
    settingsAction: openSettings && {
      label: m.git_access_settings_action(),
      onClick: openSettings,
    },
  };
}

function activeOwnerContext(): RepositoryOwnerContext {
  const space = getSpaceSnapshot();
  return {
    projectName: space.activeRootName,
    projectPath: space.activeRootPath,
    spaces: space.spaces,
  };
}

function blockerStatusLabel(blocker: RepositoryAccessBlocker) {
  const reason =
    blocker.reason === "none" || blocker.reason === "mutation_plan_changed"
      ? null
      : blocker.reason;
  return repositoryAccessPresentation({
    error: null,
    loading: false,
    verifying: false,
    snapshot: {
      repositoryId: blocker.repositoryId,
      generation: 0,
      status: blocker.status,
      reason,
      checkedAt: null,
      expiresAt: null,
      lastKnownStatus: null,
    },
  }).statusLabel;
}

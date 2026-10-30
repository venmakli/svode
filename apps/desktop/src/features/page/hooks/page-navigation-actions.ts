import { getSpaceTreeSyncSnapshot } from "@/features/space";
import {
  inferArtifactSourceShape,
  openArtifact,
  retargetActiveContent,
  retargetActiveContentInside,
} from "@/features/artifact";
import type { Page } from "../model";
import {
  followOwnContentRelocation,
  ownChangeRoot,
} from "../model/own-path-change";
import { usePageTitleOutcomeStore } from "./page-title-outcome-store";

export interface OpenPageOptions {
  scopeOpenIntent?: import("@/features/scope-surfaces").ScopeOpenIntent;
  reveal?: boolean;
  fromSidebar?: boolean;
}

export type { PageTitleOutcome } from "./page-title-outcome-store";

export function openPage(
  path: string,
  spaceId?: string | null,
  options?: OpenPageOptions,
) {
  openArtifact(
    {
      path,
      spaceId,
      sourceShape: inferArtifactSourceShape(path),
      semanticHint: { kind: "page" },
    },
    {
      reveal: options?.reveal,
      scopeOpenIntent: options?.scopeOpenIntent,
      fromSidebar: options?.fromSidebar,
    },
  );
}

export function retargetPage(fromPath: string, path: string, spaceId?: string) {
  retargetActiveContent(fromPath, path, spaceId);
}

export function publishPageTitleOutcome(
  scopePath: string,
  previousPath: string,
  page: Page,
) {
  getSpaceTreeSyncSnapshot().handoffTreePath(
    scopePath,
    previousPath,
    page.path,
  );
  usePageTitleOutcomeStore
    .getState()
    .publishTitleOutcome(scopePath, previousPath, page);
}

/**
 * Takes the open Page inside the folder this Desktop renamed or moved from
 * `fromPath` to `toPath` to the same place under its new path; called when
 * the change succeeded, before it counts as finished. A shown Page keeps its
 * session and draft, and the selection follows otherwise. A README path
 * stands for its folder.
 */
export function followContentRelocation(
  scopePath: string,
  spaceId: string,
  fromPath: string,
  toPath: string,
) {
  followOwnContentRelocation(scopePath, fromPath, toPath);
  retargetActiveContentInside(
    ownChangeRoot(fromPath),
    ownChangeRoot(toPath),
    spaceId,
  );
}

import { getSpaceTreeSyncSnapshot } from "@/features/space";
import {
  inferArtifactSourceShape,
  openArtifact,
  retargetActiveContent,
} from "@/features/artifact";
import type { Page } from "../model";
import { usePageTitleOutcomeStore } from "./page-title-outcome-store";

export interface OpenPageOptions {
  scopeOpenIntent?: import("@/features/scope-surfaces").ScopeOpenIntent;
  reveal?: boolean;
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
    { reveal: options?.reveal, scopeOpenIntent: options?.scopeOpenIntent },
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

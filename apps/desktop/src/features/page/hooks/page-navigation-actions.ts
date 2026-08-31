import {
  inferArtifactSourceShape,
  openArtifact,
  retargetActiveContent,
} from "@/features/artifact";
import type { Page } from "../model";
import { usePageTitleOutcomeStore } from "./page-title-outcome-store";

export interface OpenPageOptions {
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
    { reveal: options?.reveal },
  );
}

export function retargetPage(
  fromPath: string,
  path: string,
  spaceId?: string,
) {
  retargetActiveContent(fromPath, path, spaceId);
}

export function publishPageTitleOutcome(
  scopePath: string,
  previousPath: string,
  page: Page,
) {
  usePageTitleOutcomeStore
    .getState()
    .publishTitleOutcome(scopePath, previousPath, page);
}

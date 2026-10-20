import { create } from "zustand";
import {
  publicationBlockKey,
  type GitPublicationBlock,
  type GitPublicationBlockedSpace,
} from "./publication-block";
import type { SyncResult } from "./types";

export type GitSpacePublicationStatus =
  | "running"
  | "published"
  | "failed"
  | "not_run";

/** What happened to one Space the explicit publication took. */
export interface GitSpacePublicationStep {
  status: GitSpacePublicationStatus;
  /** The Space sync that did not publish it. */
  result?: SyncResult;
  /** The Space sync error, by the common sync error model. */
  error?: unknown;
}

/** The explicit publication of the Spaces that stop a project sync. */
export interface GitSpacesPublicationRun {
  /** The list the run started from; it stays shown while the run lasts. */
  block: GitPublicationBlock;
  running: boolean;
  /** By gitlink path relative to the project. */
  steps: Record<string, GitSpacePublicationStep>;
  /** Spaces were taken, but the project did not sync. */
  partial?: { published: number; total: number };
}

interface SpacesPublicationState {
  /** By project repository. */
  runs: Record<string, GitSpacesPublicationRun>;
  setRun: (project: string, run: GitSpacesPublicationRun | null) => void;
}

export const useSpacesPublicationStore = create<SpacesPublicationState>(
  (set) => ({
    runs: {},
    setRun: (project, run) =>
      set((s) => {
        const runs = { ...s.runs };
        if (run) runs[project] = run;
        else delete runs[project];
        return { runs };
      }),
  }),
);

/** The run of this very list, if the last one was for it. */
export function runForBlock(
  run: GitSpacesPublicationRun | undefined,
  block: GitPublicationBlock | null,
) {
  return run &&
    block &&
    publicationBlockKey(run.block) === publicationBlockKey(block)
    ? run
    : undefined;
}

/** Publishable Spaces of the list a previous run has not published yet. */
export function spacesToPublish(
  spaces: readonly GitPublicationBlockedSpace[],
  run: GitSpacesPublicationRun | undefined,
) {
  return spaces.filter(
    (space) =>
      space.publishable && run?.steps[space.path]?.status !== "published",
  );
}

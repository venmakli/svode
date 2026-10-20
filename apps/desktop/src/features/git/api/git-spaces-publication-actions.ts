import { listenGitSyncState, publishGitSpaces } from "@/platform/git/git-api";
import type {
  SpaceStepDto,
  SpacesPublicationDto,
  SyncResultDto,
} from "@/platform/git/git-types";
import {
  blockedSpaceLocation,
  repositoryLocationKey,
  selectPublication,
  useGitStore,
  useSpacesPublicationStore,
  runForBlock,
  type GitPublicationBlock,
  type GitSpacePublicationStep,
  type GitSpacesPublicationRun,
  type GitSyncOutcome,
} from "../model";
import {
  isFullSyncSuccess,
  isParentPointerPending,
} from "../model/publication";
import { toParentError, toSyncResult } from "./git-mappers";
import { recordGitSyncResult } from "./git-operation-events";
import { refreshGitPublication } from "./git-publication-actions";
import { refreshGitRemoteStatus } from "./git-status-actions";
import { gitSyncErrorMessage, toGitPublicationBlock } from "./git-sync-error";

export interface GitSpacesPublicationOutcome {
  published: number;
  /** The Spaces the fresh proof took from the requested set. */
  total: number;
  /** The project sync, when it ran or its proof refused the action. */
  project: GitSyncOutcome | null;
}

/**
 * Publish the shown publishable Spaces of a project and then, when they were
 * the whole list, sync the project; each row follows its Space sync.
 */
export async function publishBlockedSpaces(
  block: GitPublicationBlock,
  spaces: readonly { path: string; spacePath: string }[],
): Promise<GitSpacesPublicationOutcome> {
  const project = block.project;
  const runs = useSpacesPublicationStore.getState();
  const previous = runForBlock(runs.runs[project], block);
  // Spaces published by an earlier run of this list stay published.
  runs.setRun(project, {
    block,
    running: true,
    steps: Object.fromEntries(
      Object.entries(previous?.steps ?? {}).filter(
        ([, step]) => step.status === "published",
      ),
    ),
  });
  const update = (
    next: (run: GitSpacesPublicationRun) => GitSpacesPublicationRun,
  ) => {
    const run = useSpacesPublicationStore.getState().runs[project];
    if (run) useSpacesPublicationStore.getState().setRun(project, next(run));
  };

  // Each Space step is an ordinary sync of that Space.
  const byRepository = new Map<string, string>();
  for (const space of spaces) {
    byRepository.set(repositoryLocationKey(space.spacePath), space.path);
    byRepository.set(blockedSpaceLocation(project, space.path), space.path);
  }
  const unlisten = await listenGitSyncState((event) => {
    const path = byRepository.get(repositoryLocationKey(event.repository));
    if (!path) return;
    const step: GitSpacePublicationStep = event.active
      ? { status: "running" }
      : syncStep(event.report, event.error);
    update((run) => ({ ...run, steps: { ...run.steps, [path]: step } }));
  });

  let dto: SpacesPublicationDto;
  try {
    dto = await publishGitSpaces({
      projectPath: project,
      spaces: spaces.map((space) => space.path),
    });
  } catch (error) {
    // The proof of the project itself refused; nothing was published.
    update((run) => ({ ...run, running: false, steps: settled(run.steps) }));
    recordProjectResult(project, undefined, error);
    return { published: 0, total: 0, project: failedOutcome(error) };
  } finally {
    unlisten();
  }

  const published = dto.spaces.filter(
    (step) => step.status === "published",
  ).length;
  const total = dto.spaces.length;
  const synced = !!dto.project || dto.projectError != null;
  update((run) => ({
    ...run,
    running: false,
    steps: {
      ...settled(run.steps),
      ...Object.fromEntries(
        dto.spaces.map((step) => [step.path, dtoStep(step)]),
      ),
    },
    partial: synced || total === 0 ? undefined : { published, total },
  }));
  if (!synced) return { published, total, project: null };

  recordProjectResult(project, dto.project, dto.projectError);
  const outcome = dto.project
    ? toSyncResult(dto.project)
    : failedOutcome(dto.projectError);
  await recordProjectVersions(
    project,
    dto,
    outcome,
    dto.spaces
      .filter((step) => step.status === "published")
      .map((step) => blockedSpaceLocation(project, step.path)),
  );
  if (isFullSyncSuccess(outcome))
    useSpacesPublicationStore.getState().setRun(project, null);
  return { published, total, project: outcome };
}

function syncStep(
  report: SyncResultDto | null | undefined,
  error: unknown,
): GitSpacePublicationStep {
  if (error) return { status: "failed", error };
  if (!report) return { status: "not_run" };
  return report.type === "success"
    ? { status: "published" }
    : { status: "failed", result: toSyncResult(report) };
}

function dtoStep(step: SpaceStepDto): GitSpacePublicationStep {
  if (step.status !== "failed") return { status: step.status };
  return step.report && !step.error
    ? syncStep(step.report, null)
    : { status: "failed", error: step.error };
}

/** A row still marked running has no result of its own. */
function settled(steps: GitSpacesPublicationRun["steps"]) {
  return Object.fromEntries(
    Object.entries(steps).filter(([, step]) => step.status !== "running"),
  );
}

function failedOutcome(error: unknown): GitSyncOutcome {
  return {
    type: "Failed",
    message: gitSyncErrorMessage(error),
    block: toGitPublicationBlock(error) ?? undefined,
  };
}

/** The project sync result replaces the list it started from. */
function recordProjectResult(
  project: string,
  report: SyncResultDto | undefined,
  error: unknown,
) {
  const git = useGitStore.getState();
  git.setSyncError(project, null);
  git.setPublicationBlock(project, null);
  git.setBranchError(project, null);
  recordGitSyncResult(project, report, error);
  if (report?.type === "success" && !report.remoteStatus)
    void refreshGitRemoteStatus(project).catch(() => {});
}

/**
 * The project version shown by the Spaces of this project follows the
 * project sync: a synced project publishes their pointers, a failed one is
 * their project result.
 */
async function recordProjectVersions(
  project: string,
  dto: SpacesPublicationDto,
  outcome: GitSyncOutcome,
  publishedSpaces: string[],
) {
  const paths = new Set(publishedSpaces);
  for (const [path, publication] of Object.entries(
    useGitStore.getState().publications,
  ))
    if (
      repositoryLocationKey(publication.parent.repository) ===
      repositoryLocationKey(project)
    )
      paths.add(path);
  if (isFullSyncSuccess(outcome)) {
    await Promise.all(
      [...paths].map((path) => refreshGitPublication(path).catch(() => {})),
    );
    return;
  }
  for (const path of paths) {
    const git = useGitStore.getState();
    const publication = selectPublication(git, path);
    if (!publication || !isParentPointerPending(publication)) continue;
    git.setPublication(path, {
      ...publication,
      parent: {
        ...publication.parent,
        error: toParentError(dto.projectError ?? undefined),
        result: dto.project ? toSyncResult(dto.project) : undefined,
      },
    });
  }
}

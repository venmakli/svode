import { invokeCommand } from "@/platform/native/invoke";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
import type {
  CloneProgressDto,
  GitConflictFileDto,
  GitFileResolutionDto,
  GitPathConflictDto,
  GitUncommittedGroupsDto,
  PagePropertiesConflictDto,
  PagePropertiesResolutionDto,
  PublicationStatusDto,
  GitAvailabilityDto,
  GitStatusDto,
  GitUserPolicyDto,
  SpacesPublicationDto,
  SyncResultDto,
  UnpushedCommitDto,
} from "./git-types";
import type { SpaceGitTypeDto } from "@/platform/space/space-types";
import { rethrowGitSaveError } from "./save-errors";

export interface GetSpaceGitTypeInputDto extends Record<string, unknown> {
  projectPath: string;
  spacePath: string;
}

export interface GetGitSubmoduleUrlInputDto extends Record<string, unknown> {
  projectPath: string;
  spaceFolder: string;
}

export interface SetGitRemoteInputDto extends Record<string, unknown> {
  spacePath: string;
  url: string;
  projectPath?: string | null;
  spaceId?: string | null;
}

export type GitTrackedRemoteReconciliationStatusDto =
  | "not_required"
  | "updated"
  | "pending_repository_access"
  | "failed";

export interface GitTrackedRemoteReconciliationDto {
  status: GitTrackedRemoteReconciliationStatusDto;
  repositoryId?: string;
  accessStatus?: string;
  accessReason?: string;
  message?: string;
}

export interface GitSetRemoteResultDto {
  localRemoteUpdated: boolean;
  trackedReconciliation: GitTrackedRemoteReconciliationDto;
}

export interface GitCommittedEventDto {
  spacePath: string;
}

export function checkGitAvailability(): Promise<GitAvailabilityDto> {
  return invokeCommand<GitAvailabilityDto>("git_check_availability");
}

export function getGitStatus(
  spacePath: string,
  remoteCounts = false,
): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_status", { spacePath, remoteCounts });
}

/** The sync result an unfinished Git operation would give, without syncing. */
export function getGitSyncPreflight(
  spacePath: string,
): Promise<SyncResultDto | null> {
  return invokeCommand<SyncResultDto | null>("git_sync_preflight", {
    spacePath,
  });
}

export function fetchGitStatus(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_fetch_status", { spacePath });
}

export function pushGit(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_push", { spacePath });
}

export function syncGit(
  spacePath: string,
  background = false,
): Promise<SyncResultDto> {
  return invokeCommand<SyncResultDto>("git_sync", { spacePath, background });
}

/**
 * An action that starts sync of the repository of `spacePath` in its rhythm
 * (Stage 11 1.E): a Space opened (also at start), the window got focus, or a
 * commit landed. With sync off, focus returns the counters its fetch read.
 */
export function triggerGitSync(input: {
  spacePath: string;
  trigger: "opened" | "focused" | "committed";
}): Promise<GitStatusDto | null> {
  return invokeCommand<GitStatusDto | null>("git_sync_trigger", input);
}

/**
 * When the repository of `spacePath` last synced successfully on this
 * device, in milliseconds since the Unix epoch.
 */
export function getGitLastSynced(spacePath: string): Promise<number | null> {
  return invokeCommand<number | null>("git_last_synced", { spacePath });
}

/** Publish the shown Spaces that still block the project, then sync it. */
export function publishGitSpaces(input: {
  projectPath: string;
  spaces: string[];
}): Promise<SpacesPublicationDto> {
  return invokeCommand<SpacesPublicationDto>("git_publish_spaces", input);
}

export function saveGitHttpCredentials(input: {
  remoteUrl: string;
  username: string;
  password: string;
}): Promise<void> {
  return invokeCommand<void>("git_save_http_credentials", input);
}

export function commitGitFile(input: {
  projectPath?: string | null;
  spacePath: string;
  filePath: string;
}): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_commit_file", {
    projectPath: input.projectPath ?? null,
    spacePath: input.spacePath,
    filePath: input.filePath,
  }).catch(rethrowGitSaveError);
}

export function commitGitAll(input: {
  projectPath?: string | null;
  spacePath: string;
}): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_commit_all", {
    projectPath: input.projectPath ?? null,
    spacePath: input.spacePath,
  }).catch(rethrowGitSaveError);
}

export function commitGitPaths(input: {
  projectPath?: string | null;
  spacePath: string;
  filePaths: string[];
}): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_commit_paths", {
    projectPath: input.projectPath ?? null,
    spacePath: input.spacePath,
    filePaths: input.filePaths,
  }).catch(rethrowGitSaveError);
}

export function continueGitResolve(input: {
  spacePath: string;
  paths: string[];
}): Promise<SyncResultDto> {
  return invokeCommand<SyncResultDto>("git_resolve_continue", input);
}

/**
 * Merge the conflicted Svode service files of the merge in the repository by
 * the rule set (all, or the repository-relative `paths`), then continue the
 * merge.
 */
export function mergeGitServiceFiles(input: {
  spacePath: string;
  paths?: string[] | null;
}): Promise<SyncResultDto> {
  return invokeCommand<SyncResultDto>("git_merge_service_files", {
    spacePath: input.spacePath,
    paths: input.paths ?? null,
  });
}

/** The unresolved paths under `spacePath`, relative to it, with their kinds. */
export function getGitConflictKinds(
  spacePath: string,
): Promise<GitPathConflictDto[]> {
  return invokeCommand<GitPathConflictDto[]>("git_conflict_kinds", {
    spacePath,
  });
}

/**
 * The uncommitted groups of `paths` (relative to `spacePath`) with their
 * facts, as «Зафиксировать с агентом» hands them to an agent; nothing is
 * staged.
 */
export function getGitUncommittedGroups(input: {
  spacePath: string;
  paths: string[];
}): Promise<GitUncommittedGroupsDto> {
  return invokeCommand<GitUncommittedGroupsDto>("git_uncommitted_groups", input);
}

/** The Git rules for agents, as the guide and the Svode skill state them. */
export function getGitAgentRules(): Promise<string> {
  return invokeCommand<string>("git_agent_rules");
}

/** The conflicted file at `path` (relative to `spacePath`) with its places. */
export function getGitConflictFile(input: {
  spacePath: string;
  path: string;
}): Promise<GitConflictFileDto> {
  return invokeCommand<GitConflictFileDto>("git_conflict_file", input);
}

/** Resolve a conflicted text file by the person's choice, then continue the merge. */
export function resolveGitConflictFile(input: {
  spacePath: string;
  path: string;
  resolution: GitFileResolutionDto;
}): Promise<SyncResultDto> {
  return invokeCommand<SyncResultDto>("git_resolve_conflict_file", input);
}

/**
 * The properties conflict of the Page `content` with conflict markers of
 * `markerSize`: the places of its frontmatter and the text after it, `null`
 * when no marker opens in the frontmatter.
 */
export function getPagePropertiesConflict(input: {
  content: string;
  markerSize: number;
}): Promise<PagePropertiesConflictDto | null> {
  return invokeCommand<PagePropertiesConflictDto | null>(
    "git_page_properties_conflict",
    input,
  );
}

/** The frontmatter of the Page `content` with a side in every place. */
export function resolvePagePropertiesConflict(input: {
  content: string;
  markerSize: number;
  choices: ("ours" | "theirs")[];
}): Promise<PagePropertiesResolutionDto> {
  return invokeCommand<PagePropertiesResolutionDto>(
    "git_resolve_page_properties",
    input,
  );
}

/**
 * Size of the conflict markers Git writes for the Page at `path`: its
 * `conflict-marker-size` attribute, otherwise 7. Spawns Git, so call it only
 * for a body with a line starting with a run of `<` and a space.
 */
export function getGitConflictMarkerSize(input: {
  spacePath: string;
  path: string;
}): Promise<number> {
  return invokeCommand<number>("git_conflict_marker_size", input);
}

/** Abandon the merge a sync stopped in; returns the status after it. */
export function abortGitMerge(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_merge_abort", { spacePath });
}

export function publishGit(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_publish", { spacePath });
}

export function getGitUserPolicy(input: {
  spacePath: string;
  projectPath?: string | null;
}): Promise<GitUserPolicyDto> {
  return invokeCommand<GitUserPolicyDto>("git_get_user_policy", {
    spacePath: input.spacePath,
    projectPath: input.projectPath ?? null,
  });
}

export function setGitUserPolicy(input: {
  spacePath: string;
  projectPath?: string | null;
  policy: GitUserPolicyDto;
}): Promise<void> {
  return invokeCommand<void>("git_set_user_policy", {
    spacePath: input.spacePath,
    projectPath: input.projectPath ?? null,
    policy: input.policy,
  });
}

export function getGitRemote(spacePath: string): Promise<string | null> {
  return invokeCommand<string | null>("git_get_remote", { spacePath });
}

export function setGitRemote(
  input: SetGitRemoteInputDto,
): Promise<GitSetRemoteResultDto> {
  return invokeCommand<GitSetRemoteResultDto>("git_set_remote", input);
}

export function getSpaceGitType(
  input: GetSpaceGitTypeInputDto,
): Promise<SpaceGitTypeDto> {
  return invokeCommand<SpaceGitTypeDto>("get_space_git_type", input);
}

export function getGitSubmoduleUrl(
  input: GetGitSubmoduleUrlInputDto,
): Promise<string | null> {
  return invokeCommand<string | null>("git_get_submodule_url", input);
}

export function listenGitCommitted(
  handler: EventCallback<GitCommittedEventDto>,
): Promise<UnlistenFn> {
  return listen<GitCommittedEventDto>("git:committed", handler);
}

export function listenCloneProgress(
  handler: (progress: CloneProgressDto) => void,
): Promise<UnlistenFn> {
  return listen<CloneProgressDto>("clone:progress", (event) =>
    handler(event.payload),
  );
}

export function getUnpushedCommits(
  spacePath: string,
): Promise<UnpushedCommitDto[]> {
  return invokeCommand<UnpushedCommitDto[]>("git_unpushed_commits", {
    spacePath,
  });
}

export function getGitPublicationStatus(spacePath: string) {
  return invokeCommand<PublicationStatusDto | null>("git_publication_status", {
    spacePath,
  });
}

export function retryGitParent(input: {
  spacePath: string;
  expectedHead: string;
  expectedParent: string;
  expectedTarget: string;
}) {
  return invokeCommand<PublicationStatusDto>("git_retry_parent", input);
}

export function listenGitPublication(
  handler: (event: PublicationStatusDto & { spacePath: string }) => void,
) {
  return listen<PublicationStatusDto & { spacePath: string }>(
    "git:publication",
    (event) => handler(event.payload),
  );
}

/**
 * The result of automatic content versions of a repository (Stage 11 1.E):
 * the refused commit as the error of a save, or `null` when versions land
 * again.
 */
export function listenGitAutoVersion(
  handler: (event: { repository: string; error: unknown }) => void,
) {
  return listen<Parameters<typeof handler>[0]>("git:auto-version", (event) =>
    handler(event.payload),
  );
}

/** Close open content groups: the one the user left, or all of the Spaces. */
export function closeGitVersionGroups(input: {
  spacePaths: string[];
  left?: string | null;
}): Promise<void> {
  return invokeCommand<void>("git_close_version_groups", {
    spacePaths: input.spacePaths,
    left: input.left ?? null,
  });
}

export function listenGitSyncState(
  handler: (event: {
    repository: string;
    active: boolean;
    /** No person started the operation: it shows no progress. */
    background?: boolean;
    report: SyncResultDto | null;
    error: unknown;
    /** When the repository synced, for a finished successful sync. */
    syncedAt?: number | null;
  }) => void,
) {
  return listen<Parameters<typeof handler>[0]>("git:sync-state", (event) =>
    handler(event.payload),
  );
}

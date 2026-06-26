import { invokeCommand } from "@/platform/native/invoke";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
import type {
  CloneProgressDto,
  GitAvailabilityDto,
  GitStatusDto,
  SyncResultDto,
  UnpushedCommitDto,
} from "./git-types";
import type { SpaceGitTypeDto } from "@/platform/space/space-types";

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

export interface GitCommittedEventDto {
  spacePath: string;
}

export function checkGitAvailability(): Promise<GitAvailabilityDto> {
  return invokeCommand<GitAvailabilityDto>("git_check_availability");
}

export function getGitStatus(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_status", { spacePath });
}

export function pushGit(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_push", { spacePath });
}

export function syncGit(spacePath: string): Promise<SyncResultDto> {
  return invokeCommand<SyncResultDto>("git_sync", { spacePath });
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
  });
}

export function commitGitAll(input: {
  projectPath?: string | null;
  spacePath: string;
}): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_commit_all", {
    projectPath: input.projectPath ?? null,
    spacePath: input.spacePath,
  });
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
  });
}

export function continueGitResolve(spacePath: string): Promise<void> {
  return invokeCommand<void>("git_resolve_continue", { spacePath });
}

export function publishGit(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_publish", { spacePath });
}

export function enableGitAutoSync(input: {
  spacePath: string;
  projectPath?: string | null;
}): Promise<void> {
  return invokeCommand<void>("git_enable_auto_sync", {
    spacePath: input.spacePath,
    projectPath: input.projectPath ?? null,
  });
}

export function getGitRemote(spacePath: string): Promise<string | null> {
  return invokeCommand<string | null>("git_get_remote", { spacePath });
}

export function setGitRemote(input: SetGitRemoteInputDto): Promise<void> {
  return invokeCommand<void>("git_set_remote", input);
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

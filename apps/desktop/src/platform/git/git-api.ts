import { invokeCommand } from "@/platform/native/invoke";
import type {
  GitAvailabilityDto,
  GitStatusDto,
  SyncResultDto,
  UnpushedCommitDto,
} from "./git-types";

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

export function getUnpushedCommits(
  spacePath: string,
): Promise<UnpushedCommitDto[]> {
  return invokeCommand<UnpushedCommitDto[]>("git_unpushed_commits", {
    spacePath,
  });
}

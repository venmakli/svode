import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";
import {
  checkGitAvailability,
  getGitRemote,
  getGitStatus,
} from "@/platform/git/git-api";
import { getSpaceConfig, saveSpaceConfig } from "@/platform/space/space-api";

import type { ModelOption } from "@/features/chat";
import type {
  FanoutPreviewEntry,
  RepoIdentityResult,
} from "@/features/identity";
import type { GitAvailability, GitStatus } from "@/features/git";
import type {
  AssetsS3Config,
  AssetsStrategy,
  LfsState,
  SpaceConfig,
  SpaceGitType,
} from "@/features/space";

export interface SpacePoolInput extends Record<string, unknown> {
  projectPath: string;
  spaceId: string | null;
}

export interface SaveSettingsSpaceConfigInput extends Record<string, unknown> {
  spacePath: string;
  configData: SpaceConfig;
  projectPath?: string | null;
}

export interface GetSpaceGitTypeInput extends Record<string, unknown> {
  projectPath: string;
  spacePath: string;
}

export interface GetGitSubmoduleUrlInput extends Record<string, unknown> {
  projectPath: string;
  spaceFolder: string;
}

export interface SetupCliSymlinksInput extends Record<string, unknown> {
  spacePath: string;
  cliName: string;
  projectPath?: string | null;
}

export interface SetGitRemoteInput extends Record<string, unknown> {
  spacePath: string;
  url: string;
  projectPath?: string | null;
  spaceId?: string | null;
}

export interface SaveRepoIdentityInput extends Record<string, unknown> {
  repoPath: string;
  name: string | null;
  email: string | null;
}

export interface SaveProjectIdentityInput extends Record<string, unknown> {
  rootPath: string;
  name: string | null;
  email: string | null;
  targetSpaces: string[];
}

export interface S3CredentialsInput extends Record<string, unknown> {
  accessKey: string;
  secretKey: string;
}

export interface CheckS3ConnectionInput
  extends AssetsS3Config, Record<string, unknown> {
  accessKey: string;
  secretKey: string;
}

export interface SetAssetsStrategyInput extends SpacePoolInput {
  strategy: AssetsStrategy;
  s3Config: AssetsS3Config | null;
  s3Credentials: S3CredentialsInput | null;
}

export interface SetAssetsStrategyResult {
  warnings: string[];
}

export interface LfsStateChangedEvent {
  projectPath: string;
  spaceId: string | null;
  state: LfsState;
}

export interface GitCommittedEvent {
  spacePath: string;
}

export function getSettingsSpaceConfig(
  spacePath: string,
): Promise<SpaceConfig> {
  return getSpaceConfig(spacePath);
}

export function saveSettingsSpaceConfig({
  spacePath,
  configData,
  projectPath,
}: SaveSettingsSpaceConfigInput): Promise<void> {
  return saveSpaceConfig(spacePath, configData, projectPath);
}

export function hasS3Credentials(input: SpacePoolInput): Promise<boolean> {
  return invokeCommand<boolean>("has_s3_credentials", input);
}

export function getLfsState(input: SpacePoolInput): Promise<LfsState> {
  return invokeCommand<LfsState>("get_lfs_state", input);
}

export function repairLfs(input: SpacePoolInput): Promise<LfsState> {
  return invokeCommand<LfsState>("repair_lfs", input);
}

export function getSpaceGitType(
  input: GetSpaceGitTypeInput,
): Promise<SpaceGitType> {
  return invokeCommand<SpaceGitType>("get_space_git_type", input);
}

export function getGitSubmoduleUrl(
  input: GetGitSubmoduleUrlInput,
): Promise<string | null> {
  return invokeCommand<string | null>("git_get_submodule_url", input);
}

export function getSettingsGitRemote(
  spacePath: string,
): Promise<string | null> {
  return getGitRemote(spacePath);
}

export function getSettingsGitStatus(spacePath: string): Promise<GitStatus> {
  return getGitStatus(spacePath);
}

export function getSettingsGitAvailability(): Promise<GitAvailability> {
  return checkGitAvailability();
}

export function getRepoIdentity(repoPath: string): Promise<RepoIdentityResult> {
  return invokeCommand<RepoIdentityResult>("get_repo_identity", { repoPath });
}

export function getProjectFanoutPreview(
  rootPath: string,
): Promise<FanoutPreviewEntry[]> {
  return invokeCommand<FanoutPreviewEntry[]>("get_project_fanout_preview", {
    rootPath,
  });
}

export function saveRepoIdentity(input: SaveRepoIdentityInput): Promise<void> {
  return invokeCommand<void>("set_repo_identity", input);
}

export function saveProjectIdentity(
  input: SaveProjectIdentityInput,
): Promise<void> {
  return invokeCommand<void>("set_project_identity", input);
}

export function listAgentModels(spacePath: string): Promise<ModelOption[]> {
  return invokeCommand<ModelOption[]>("agent_list_models", { spacePath });
}

export function readAgentsMd(spacePath: string): Promise<string | null> {
  return invokeCommand<string | null>("read_agents_md", { spacePath });
}

export function setupCliSymlinks(
  input: SetupCliSymlinksInput,
): Promise<string[]> {
  return invokeCommand<string[]>("setup_cli_symlinks_cmd", input);
}

export function teardownCliSymlinks(
  input: SetupCliSymlinksInput,
): Promise<void> {
  return invokeCommand<void>("teardown_cli_symlinks_cmd", input);
}

export function countBrokenLinks(projectPath: string): Promise<number> {
  return invokeCommand<number>("count_broken_links", { projectPath });
}

export function setGitRemote(input: SetGitRemoteInput): Promise<void> {
  return invokeCommand<void>("git_set_remote", input);
}

export function countAssets(input: SpacePoolInput): Promise<number> {
  return invokeCommand<number>("count_assets", input);
}

export function checkS3Connection(
  input: CheckS3ConnectionInput,
): Promise<boolean> {
  return invokeCommand<boolean>("check_s3_connection", input);
}

export function applyAssetsStrategy(
  input: SetAssetsStrategyInput,
): Promise<SetAssetsStrategyResult> {
  return invokeCommand<SetAssetsStrategyResult>("set_assets_strategy", input);
}

export function listenLfsStateChanged(
  handler: EventCallback<LfsStateChangedEvent>,
): Promise<UnlistenFn> {
  return listen<LfsStateChangedEvent>("space:lfs_state_changed", handler);
}

export function listenGitCommitted(
  handler: EventCallback<GitCommittedEvent>,
): Promise<UnlistenFn> {
  return listen<GitCommittedEvent>("git:committed", handler);
}

import {
  listAgentModels as listPlatformAgentModels,
  readAgentsMd as readPlatformAgentsMd,
  setupCliSymlinks as setupPlatformCliSymlinks,
  teardownCliSymlinks as teardownPlatformCliSymlinks,
} from "@/platform/agent/agent-api";
import {
  checkGitAvailability,
  getGitSubmoduleUrl as getPlatformGitSubmoduleUrl,
  getGitRemote,
  getGitStatus,
  getSpaceGitType as getPlatformSpaceGitType,
  listenGitCommitted as listenPlatformGitCommitted,
  setGitRemote as setPlatformGitRemote,
} from "@/platform/git/git-api";
import {
  applyAssetsStrategy as applyPlatformAssetsStrategy,
  checkS3Connection as checkPlatformS3Connection,
  countAssets as countPlatformAssets,
  countBrokenLinks as countPlatformBrokenLinks,
  getLfsState as getPlatformLfsState,
  getSpaceConfig,
  hasS3Credentials as hasPlatformS3Credentials,
  listenLfsStateChanged as listenPlatformLfsStateChanged,
  repairLfs as repairPlatformLfs,
  saveSpaceConfig,
} from "@/platform/space/space-api";
import {
  getProjectFanoutPreview as getPlatformProjectFanoutPreview,
  getRepoIdentity as getPlatformRepoIdentity,
  saveProjectIdentity as savePlatformProjectIdentity,
  saveRepoIdentity as savePlatformRepoIdentity,
} from "@/platform/identity/identity-api";

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

interface SettingsEvent<T> {
  payload: T;
}

type SettingsEventCallback<T> = (event: SettingsEvent<T>) => void;
type SettingsUnlistenFn = () => void;

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
  return hasPlatformS3Credentials(input);
}

export function getLfsState(input: SpacePoolInput): Promise<LfsState> {
  return getPlatformLfsState(input);
}

export function repairLfs(input: SpacePoolInput): Promise<LfsState> {
  return repairPlatformLfs(input);
}

export function getSpaceGitType(
  input: GetSpaceGitTypeInput,
): Promise<SpaceGitType> {
  return getPlatformSpaceGitType(input);
}

export function getGitSubmoduleUrl(
  input: GetGitSubmoduleUrlInput,
): Promise<string | null> {
  return getPlatformGitSubmoduleUrl(input);
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
  return getPlatformRepoIdentity(repoPath);
}

export function getProjectFanoutPreview(
  rootPath: string,
): Promise<FanoutPreviewEntry[]> {
  return getPlatformProjectFanoutPreview(rootPath);
}

export function saveRepoIdentity(input: SaveRepoIdentityInput): Promise<void> {
  return savePlatformRepoIdentity(input);
}

export function saveProjectIdentity(
  input: SaveProjectIdentityInput,
): Promise<void> {
  return savePlatformProjectIdentity(input);
}

export function listAgentModels(spacePath: string): Promise<ModelOption[]> {
  return listPlatformAgentModels(spacePath);
}

export function readAgentsMd(spacePath: string): Promise<string | null> {
  return readPlatformAgentsMd(spacePath);
}

export function setupCliSymlinks(
  input: SetupCliSymlinksInput,
): Promise<string[]> {
  return setupPlatformCliSymlinks(input);
}

export function teardownCliSymlinks(
  input: SetupCliSymlinksInput,
): Promise<void> {
  return teardownPlatformCliSymlinks(input);
}

export function countBrokenLinks(projectPath: string): Promise<number> {
  return countPlatformBrokenLinks(projectPath);
}

export function setGitRemote(input: SetGitRemoteInput): Promise<void> {
  return setPlatformGitRemote(input);
}

export function countAssets(input: SpacePoolInput): Promise<number> {
  return countPlatformAssets(input);
}

export function checkS3Connection(
  input: CheckS3ConnectionInput,
): Promise<boolean> {
  return checkPlatformS3Connection(input);
}

export function applyAssetsStrategy(
  input: SetAssetsStrategyInput,
): Promise<SetAssetsStrategyResult> {
  return applyPlatformAssetsStrategy(input);
}

export function listenLfsStateChanged(
  handler: SettingsEventCallback<LfsStateChangedEvent>,
): Promise<SettingsUnlistenFn> {
  return listenPlatformLfsStateChanged(handler);
}

export function listenGitCommitted(
  handler: SettingsEventCallback<GitCommittedEvent>,
): Promise<SettingsUnlistenFn> {
  return listenPlatformGitCommitted(handler);
}

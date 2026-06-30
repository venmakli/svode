import {
  applyAssetsStrategy as applyPlatformAssetsStrategy,
  checkS3Connection as checkPlatformS3Connection,
  countAssets as countPlatformAssets,
  diagnoseLfsRemote as diagnosePlatformLfsRemote,
  getAssetsConfig as getPlatformAssetsConfig,
  getLfsState as getPlatformLfsState,
  hasS3Credentials as hasPlatformS3Credentials,
  listenLfsStateChanged as listenPlatformLfsStateChanged,
  repairLfs as repairPlatformLfs,
} from "@/platform/space/space-api";

import type {
  AssetsS3Config,
  AssetsStrategy,
  LfsState,
  SpaceGitType,
} from "@/features/space";

export interface SpacePoolInput extends Record<string, unknown> {
  projectPath: string;
  spaceId: string | null;
}

export interface S3CredentialsInput extends Record<string, unknown> {
  accessKey: string;
  secretKey: string;
}

export interface CheckS3ConnectionInput extends Record<string, unknown> {
  endpoint: string;
  bucket: string;
  region: string;
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

export interface EffectiveAssetsConfig {
  strategy: AssetsStrategy;
  s3?: AssetsS3Config;
  defaultS3Prefix: string;
  inheritedFromProject: boolean;
  ownerSpaceId: string | null;
  gitType: SpaceGitType | null;
}

export interface LfsStateChangedEvent {
  projectPath: string;
  spaceId: string | null;
  state: LfsState;
}

export type LfsRemoteDiagnosticReason =
  | "ready"
  | "git-lfs-missing"
  | "remote-missing"
  | "auth-required"
  | "lfs-unavailable"
  | "probe-failed";
export type LfsRemoteAuthMethod = "https" | "ssh" | "unknown";

export interface LfsRemoteDiagnostic {
  state: LfsState;
  reason: LfsRemoteDiagnosticReason;
  authMethod: LfsRemoteAuthMethod;
  remoteUrl: string | null;
  terminalCommand: string | null;
  detail: string | null;
}

interface SettingsEvent<T> {
  payload: T;
}

type SettingsEventCallback<T> = (event: SettingsEvent<T>) => void;
type SettingsUnlistenFn = () => void;

export function hasS3Credentials(input: SpacePoolInput): Promise<boolean> {
  return hasPlatformS3Credentials(input);
}

export function getAssetsConfig(
  input: SpacePoolInput,
): Promise<EffectiveAssetsConfig> {
  return getPlatformAssetsConfig(input);
}

export function getLfsState(input: SpacePoolInput): Promise<LfsState> {
  return getPlatformLfsState(input);
}

export function diagnoseLfsRemote(
  input: SpacePoolInput,
): Promise<LfsRemoteDiagnostic> {
  return diagnosePlatformLfsRemote(input);
}

export function repairLfs(input: SpacePoolInput): Promise<LfsState> {
  return repairPlatformLfs(input);
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

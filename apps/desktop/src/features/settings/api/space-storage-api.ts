import {
  applyAssetsStrategy as applyPlatformAssetsStrategy,
  checkS3Bindings as checkPlatformS3Bindings,
  countAssets as countPlatformAssets,
  diagnoseLfsPolicy as diagnosePlatformLfsPolicy,
  diagnoseLfsRemote as diagnosePlatformLfsRemote,
  getAssetsConfig as getPlatformAssetsConfig,
  getS3Bindings as getPlatformS3Bindings,
  getLfsState as getPlatformLfsState,
  hasS3Credentials as hasPlatformS3Credentials,
  listenLfsStateChanged as listenPlatformLfsStateChanged,
  repairLfs as repairPlatformLfs,
} from "@/platform/space/space-api";

import type {
  AssetsS3Config,
  AssetsStrategy,
  BinaryRoutingConfig,
  LfsState,
  SpaceGitType,
} from "@/features/space";

export interface SpacePoolInput extends Record<string, unknown> {
  projectPath: string;
  spaceId: string | null;
}

export interface S3SecretBindings {
  accessKey: string;
  secretKey: string;
}

export interface S3BindingState {
  bindings: S3SecretBindings | null;
  ready: boolean;
  error: string | null;
}

export interface CheckS3BindingsInput extends SpacePoolInput {
  target: AssetsS3Config;
  bindings: S3SecretBindings;
}

export interface SetAssetsStrategyInput extends SpacePoolInput {
  strategy: AssetsStrategy;
  binaryRouting: BinaryRoutingConfig;
  s3Config: AssetsS3Config | null;
  s3Bindings: S3SecretBindings | null;
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
  binaryRouting: {
    status: "legacy-preset" | "v1" | "unsupported";
    version: number | null;
    lfsExtensions: string[];
    lfsThresholdBytes: number | null;
  };
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

export interface LfsPolicyDiagnostic {
  managedPolicyCurrent: boolean;
  uncoveredPaths: string[];
  truncatedCount: number;
}

interface SettingsEvent<T> {
  payload: T;
}

type SettingsEventCallback<T> = (event: SettingsEvent<T>) => void;
type SettingsUnlistenFn = () => void;

export function getS3Bindings(input: SpacePoolInput): Promise<S3BindingState> {
  return getPlatformS3Bindings(input);
}

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

export function diagnoseLfsPolicy(
  input: SpacePoolInput,
): Promise<LfsPolicyDiagnostic> {
  return diagnosePlatformLfsPolicy(input);
}

export function repairLfs(input: SpacePoolInput): Promise<LfsState> {
  return repairPlatformLfs(input);
}

export function countAssets(input: SpacePoolInput): Promise<number> {
  return countPlatformAssets(input);
}

export function checkS3Bindings(input: CheckS3BindingsInput): Promise<boolean> {
  return checkPlatformS3Bindings(input);
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

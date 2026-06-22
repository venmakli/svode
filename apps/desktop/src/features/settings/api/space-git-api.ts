import {
  getGitRemote,
  getGitSubmoduleUrl as getPlatformGitSubmoduleUrl,
  getSpaceGitType as getPlatformSpaceGitType,
  listenGitCommitted as listenPlatformGitCommitted,
  setGitRemote as setPlatformGitRemote,
} from "@/platform/git/git-api";

import {
  getGitAvailability,
  getGitStatusSnapshot,
  type GitAvailability,
  type GitStatus,
} from "@/features/git";
import type { SpaceGitType } from "@/features/space";

export interface GetSpaceGitTypeInput extends Record<string, unknown> {
  projectPath: string;
  spacePath: string;
}

export interface GetGitSubmoduleUrlInput extends Record<string, unknown> {
  projectPath: string;
  spaceFolder: string;
}

export interface SetGitRemoteInput extends Record<string, unknown> {
  spacePath: string;
  url: string;
  projectPath?: string | null;
  spaceId?: string | null;
}

export interface GitCommittedEvent {
  spacePath: string;
}

interface SettingsEvent<T> {
  payload: T;
}

type SettingsEventCallback<T> = (event: SettingsEvent<T>) => void;
type SettingsUnlistenFn = () => void;

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
  return getGitStatusSnapshot(spacePath);
}

export function getSettingsGitAvailability(): Promise<GitAvailability> {
  return getGitAvailability();
}

export function setGitRemote(input: SetGitRemoteInput): Promise<void> {
  return setPlatformGitRemote(input);
}

export function listenGitCommitted(
  handler: SettingsEventCallback<GitCommittedEvent>,
): Promise<SettingsUnlistenFn> {
  return listenPlatformGitCommitted(handler);
}

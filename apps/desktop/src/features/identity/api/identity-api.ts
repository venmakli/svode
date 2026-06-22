import {
  getGlobalIdentity as getPlatformGlobalIdentity,
  getProjectFanoutPreview as getPlatformProjectFanoutPreview,
  getRepoIdentity as getPlatformRepoIdentity,
  saveGlobalIdentity as savePlatformGlobalIdentity,
  saveProjectIdentity as savePlatformProjectIdentity,
  saveRepoIdentity as savePlatformRepoIdentity,
} from "@/platform/identity/identity-api";

import type {
  FanoutPreviewEntry,
  GlobalIdentityResult,
  RepoIdentityResult,
} from "../model";

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

export function getGlobalIdentity(): Promise<GlobalIdentityResult> {
  return getPlatformGlobalIdentity();
}

export function saveGlobalIdentity(name: string, email: string): Promise<void> {
  return savePlatformGlobalIdentity({ name, email });
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

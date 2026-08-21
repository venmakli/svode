import {
  getGlobalIdentity as getPlatformGlobalIdentity,
  getProjectFanoutPreview as getPlatformProjectFanoutPreview,
  getRepoIdentity as getPlatformRepoIdentity,
  listenGlobalIdentityChanged as listenPlatformGlobalIdentityChanged,
  saveGlobalIdentity as savePlatformGlobalIdentity,
  saveProjectIdentity as savePlatformProjectIdentity,
  saveRepoIdentity as savePlatformRepoIdentity,
} from "@/platform/identity/identity-api";

import type {
  FanoutPreviewEntry,
  GlobalIdentityMutationResult,
  GlobalIdentityResult,
  RepoIdentityResult,
} from "../model";

export interface SaveRepoIdentityInput {
  repoPath: string;
  name: string | null;
  email: string | null;
}

export interface SaveProjectIdentityInput {
  rootPath: string;
  name: string | null;
  email: string | null;
  targetSpaces: string[];
}

export function getGlobalIdentity(): Promise<GlobalIdentityResult> {
  return getPlatformGlobalIdentity();
}

export function saveGlobalIdentity(
  name: string,
  email: string,
  expectedFingerprint: string,
): Promise<GlobalIdentityMutationResult> {
  return savePlatformGlobalIdentity({ name, email, expectedFingerprint });
}

export function listenGlobalIdentityChanged(
  handler: () => void,
): Promise<() => void> {
  return listenPlatformGlobalIdentityChanged(handler);
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
  return savePlatformRepoIdentity({
    repoPath: input.repoPath,
    name: input.name,
    email: input.email,
  });
}

export function saveProjectIdentity(
  input: SaveProjectIdentityInput,
): Promise<void> {
  return savePlatformProjectIdentity({
    rootPath: input.rootPath,
    name: input.name,
    email: input.email,
    targetSpaces: input.targetSpaces,
  });
}

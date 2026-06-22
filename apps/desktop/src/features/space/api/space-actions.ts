import { pathExists } from "@/platform/filesystem/path-api";
import {
  cloneMissingSpace as cloneMissingSpaceNative,
  cloneSpace,
  getSpaceConfig,
  listenLfsStateChanged,
  registerClonedSpace,
  removeMissingSpace as removeMissingSpaceNative,
  saveSpaceConfig,
} from "@/platform/space/space-api";
import { listen } from "@/platform/native/events";
import type { LfsState, SpaceConfig, SpaceGitType } from "../model/types";

export interface SpaceLfsStateChanged {
  projectPath: string;
  spaceId: string | null;
  state: LfsState;
}

export interface SpaceCloneProgress {
  spacePath: string;
  phase: string;
  percent: number;
}

export interface CloneAndRegisterSpaceInput {
  url: string;
  targetPath: string;
  parentPath: string;
  folderName: string;
  fallbackName: string;
  fallbackIcon: string;
  gitType: SpaceGitType;
}

export function spacePathExists(spacePath: string): Promise<boolean> {
  return pathExists(spacePath);
}

export async function renameSpace(input: {
  spacePath: string;
  name: string;
  projectPath: string;
}): Promise<SpaceConfig> {
  const config = await getSpaceConfig(input.spacePath);
  const nextConfig = { ...config, name: input.name };
  await saveSpaceConfig(input.spacePath, nextConfig, input.projectPath);
  return nextConfig;
}

export function cloneMissingSpace(input: {
  projectPath: string;
  spaceId: string;
}): Promise<void> {
  return cloneMissingSpaceNative(input.projectPath, input.spaceId);
}

export async function cloneAndRegisterSpace(
  input: CloneAndRegisterSpaceInput,
): Promise<void> {
  await cloneSpace({
    url: input.url,
    targetPath: input.targetPath,
    projectPath: input.parentPath,
    gitType: input.gitType,
  });
  await registerClonedSpace({
    parentPath: input.parentPath,
    folderName: input.folderName,
    fallbackName: input.fallbackName,
    fallbackIcon: input.fallbackIcon,
    url: input.url,
    gitType: input.gitType,
  });
}

export function removeMissingSpace(input: {
  projectPath: string;
  spaceId: string;
}): Promise<void> {
  return removeMissingSpaceNative(input.projectPath, input.spaceId);
}

export function listenSpaceLfsStateChanged(
  handler: (event: SpaceLfsStateChanged) => void,
): Promise<() => void> {
  return listenLfsStateChanged((event) => handler(event.payload));
}

export function listenSpaceCloneProgress(
  handler: (progress: SpaceCloneProgress) => void,
): Promise<() => void> {
  return listen<SpaceCloneProgress>("clone:progress", (event) =>
    handler(event.payload),
  );
}

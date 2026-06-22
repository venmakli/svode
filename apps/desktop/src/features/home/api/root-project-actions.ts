import { pickDirectory } from "@/platform/filesystem/native-file-picker";
import { pathExists } from "@/platform/filesystem/path-api";
import { listen } from "@/platform/native/events";
import { cloneProject } from "@/platform/space/space-api";
import type { CloneProgressDto } from "@/platform/git/git-types";
import type { SpaceInfo } from "@/features/space";

export type RootProjectCloneProgress = CloneProgressDto;

export function pickRootProjectFolder(): Promise<string | null> {
  return pickDirectory();
}

export function rootProjectPathExists(path: string): Promise<boolean> {
  return pathExists(path);
}

export function cloneRootProject(
  url: string,
  targetPath: string,
): Promise<SpaceInfo> {
  return cloneProject(url, targetPath);
}

export function listenRootProjectCloneProgress(
  handler: (progress: RootProjectCloneProgress) => void,
): Promise<() => void> {
  return listen<RootProjectCloneProgress>("clone:progress", (event) =>
    handler(event.payload),
  );
}

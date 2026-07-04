import { pickDirectory } from "@/platform/filesystem/native-file-picker";
import { pathExists } from "@/platform/filesystem/path-api";
import { listenCloneProgress } from "@/platform/git/git-api";
import { listen } from "@/platform/native/events";
import { setCurrentAppWindowTitle } from "@/platform/native/window";
import { cloneProject } from "@/platform/space/space-api";
import type { SpaceInfo } from "@/features/space";

export interface RootProjectCloneProgress {
  spacePath: string;
  phase: string;
  percent: number;
}

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
  return listenCloneProgress(handler);
}

export function listenRootProjectOpenFolderRequest(
  handler: () => void,
): Promise<() => void> {
  return listen("app-menu:open-folder", () => handler());
}

export function setRootProjectLauncherWindowTitle(): Promise<void> {
  return setCurrentAppWindowTitle("Svode");
}

import { openProjectInApp } from "@/platform/project-openers";
import {
  listenProjectWindowsChanged,
  listProjectsInOtherWindows,
} from "@/platform/space/space-api";

export function listHomeProjectsInOtherWindows(): Promise<string[]> {
  return listProjectsInOtherWindows();
}

export function listenHomeProjectWindowsChanged(
  handler: () => void,
): Promise<() => void> {
  return listenProjectWindowsChanged(handler);
}

/** Shows the project folder in the file manager of the OS. */
export function revealHomeProjectFolder(projectPath: string): Promise<void> {
  return openProjectInApp(projectPath, "file_manager");
}

export function copyHomeProjectPath(projectPath: string): Promise<void> {
  return navigator.clipboard.writeText(projectPath);
}

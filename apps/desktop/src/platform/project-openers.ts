import { invokeCommand as invoke } from "@/platform/native/invoke";

export type ProjectOpenerId =
  | "vscode"
  | "cursor"
  | "file_manager"
  | "terminal"
  | "iterm2";

export type ProjectOpenerKind = "editor" | "file_manager" | "terminal";

export interface ProjectOpener {
  id: ProjectOpenerId;
  label: string;
  kind: ProjectOpenerKind;
}

export function listProjectOpeners(): Promise<ProjectOpener[]> {
  return invoke<ProjectOpener[]>("list_project_openers");
}

export function openProjectInTool(
  projectPath: string,
  tool: ProjectOpenerId,
): Promise<void> {
  return invoke("open_project_in_tool", { projectPath, tool });
}

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

export type ArtifactOpenerCapability =
  | "open_workspace_file"
  | "reveal_file"
  | "open_directory";

export interface ArtifactOpener {
  id: Exclude<ProjectOpenerId, "cursor">;
  label: string;
  kind: ProjectOpenerKind;
  capabilities: readonly ArtifactOpenerCapability[];
}

export interface ArtifactOpenTarget {
  ownerRoot: string;
  canonicalArtifactPath: string;
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

export function listArtifactOpeners(): Promise<ArtifactOpener[]> {
  return invoke<ArtifactOpener[]>("list_artifact_openers");
}

export function openArtifactInTool(
  target: ArtifactOpenTarget,
  tool: ArtifactOpener["id"],
): Promise<void> {
  return invoke("open_artifact_in_tool", { target, tool });
}

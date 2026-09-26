import { invokeCommand as invoke } from "@/platform/native/invoke";

export type ExternalAppKind = "editor" | "file_manager" | "terminal";

/** An installed external application as reported by the OS for a target. */
export interface ExternalAppDto {
  /** Opaque id, re-resolved by the backend before every launch. */
  id: string;
  label: string;
  /** Symbolic fallback class shown when the OS returned no icon. */
  kind: ExternalAppKind;
  isDefault: boolean;
  /** `data:` URL of the application icon. */
  icon: string | null;
}

export type ArtifactOpenerCapability =
  | "open_workspace_file"
  | "reveal_file"
  | "open_directory";

export interface ArtifactOpenerDto extends ExternalAppDto {
  capabilities: readonly ArtifactOpenerCapability[];
}

export interface ArtifactOpenTarget {
  ownerRoot: string;
  canonicalArtifactPath: string;
}

export function listProjectOpeners(): Promise<ExternalAppDto[]> {
  return invoke<ExternalAppDto[]>("list_project_openers");
}

/** Opens a directory in `appId`, or in the OS default application for `null`. */
export function openProjectInApp(
  projectPath: string,
  appId: string | null,
): Promise<void> {
  return invoke("open_project_in_tool", { projectPath, app: appId });
}

export function listArtifactOpeners(): Promise<ArtifactOpenerDto[]> {
  return invoke<ArtifactOpenerDto[]>("list_artifact_openers");
}

export function openArtifactInTool(
  target: ArtifactOpenTarget,
  tool: string,
): Promise<void> {
  return invoke("open_artifact_in_tool", { target, tool });
}

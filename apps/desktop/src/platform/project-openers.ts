import { invokeCommand as invoke } from "@/platform/native/invoke";

export type ExternalAppKind =
  | "editor"
  | "file_manager"
  | "terminal"
  | "application";

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

/** Applications the OS offers for an artifact file, its default first. */
export function listArtifactApps(
  target: ArtifactOpenTarget,
): Promise<ExternalAppDto[]> {
  return invoke<ExternalAppDto[]>("list_artifact_apps", { target });
}

/** Opens an artifact file in `appId`, or in the OS default application for `null`. */
export function openArtifactInApp(
  target: ArtifactOpenTarget,
  appId: string | null,
): Promise<void> {
  return invoke("open_artifact_in_app", { target, appId });
}

export function openArtifactInTool(
  target: ArtifactOpenTarget,
  tool: string,
): Promise<void> {
  return invoke("open_artifact_in_tool", { target, tool });
}

import { invokeCommand } from "@/platform/native/invoke";
import { listen } from "@/platform/native/events";

export interface AppOwnerDto {
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  ownerPath: string;
}

export interface AppManifestDiagnosticDto {
  code: string;
  path: string;
  message: string;
}

export type AppRuntimeTypeDto = "static" | "process" | "url";
export type AppProcessPhaseDto = "setup" | "starting" | "waiting_for_url";
export type AppProcessControlActionDto =
  | "retry"
  | "restart"
  | "stop"
  | "rerun_setup";

export interface AppProcessLogsDto {
  stdout: string;
  stderr: string;
}

export interface AppProcessDetailsDto {
  managed: boolean;
  hasSetup: boolean;
  logs: AppProcessLogsDto;
}

export interface MissingAppVariableDto {
  referenceName: string;
  entryName: string;
}

export type AppManifestInspectionDto =
  | { status: "missing"; ownerDirectory: string }
  | {
      status: "invalid";
      ownerDirectory: string;
      diagnostics: AppManifestDiagnosticDto[];
    }
  | {
      status: "ready";
      ownerDirectory: string;
      runtimeType: Exclude<AppRuntimeTypeDto, "process">;
      viewportUrl: string;
      capabilityToken?: string;
      process?: never;
    }
  | {
      status: "ready";
      ownerDirectory: string;
      runtimeType: "process";
      viewportUrl: string;
      capabilityToken?: never;
      process: AppProcessDetailsDto;
    }
  | {
      status: "launching";
      ownerDirectory: string;
      runtimeType: "process";
      phase: AppProcessPhaseDto;
      browserUrl: string;
      process: AppProcessDetailsDto;
    }
  | {
      status: "unavailable";
      ownerDirectory: string;
      runtimeType: Exclude<AppRuntimeTypeDto, "process">;
      reason: string;
      browserUrl?: string;
      process?: never;
    }
  | {
      status: "unavailable";
      ownerDirectory: string;
      runtimeType: "process";
      reason: string;
      browserUrl?: string;
      process: AppProcessDetailsDto;
      missingVariables?: MissingAppVariableDto[];
    };

interface AppFileEventDto {
  space?: string;
  path: string;
  kind?: "page" | "schema" | "app" | "folder" | "unknown";
}

function backendSpaceId(owner: AppOwnerDto): string | null {
  return owner.projectPath === owner.spacePath ? null : owner.spaceId;
}

function backendOwner(owner: AppOwnerDto) {
  return {
    projectPath: owner.projectPath,
    spaceId: backendSpaceId(owner),
    ownerPath: owner.ownerPath,
  };
}

export async function inspectAppManifest(
  owner: AppOwnerDto,
): Promise<AppManifestInspectionDto> {
  const inspection = await invokeCommand<AppManifestInspectionDto>(
    "app_manifest_inspect",
    backendOwner(owner),
  );
  return inspection;
}

export function controlAppProcess(
  owner: AppOwnerDto,
  action: AppProcessControlActionDto,
): Promise<AppManifestInspectionDto> {
  return invokeCommand("app_process_control", {
    ...backendOwner(owner),
    action,
  });
}

export function revokeAppSource(capabilityToken: string): Promise<void> {
  return invokeCommand("app_source_revoke", { capabilityToken });
}

export function openAppOwnerDirectory(owner: AppOwnerDto): Promise<void> {
  return invokeCommand("app_open_owner_directory", backendOwner(owner));
}

export function openAppUrlInBrowser(url: string): Promise<void> {
  return invokeCommand("app_open_browser", { url });
}

export function listenAppManifestChanges(
  owner: AppOwnerDto,
  onChange: () => void,
): Promise<() => void> {
  const manifestPath =
    owner.ownerPath === "." ? "app.yaml" : `${owner.ownerPath}/app.yaml`;
  const handleEvent = (event: { payload: AppFileEventDto }) => {
    if (event.payload.space && event.payload.space !== owner.spacePath) return;
    if (event.payload.kind !== "app" || event.payload.path !== manifestPath)
      return;
    onChange();
  };

  return Promise.all([
    listen<AppFileEventDto>("file:created", handleEvent),
    listen<AppFileEventDto>("file:changed", handleEvent),
    listen<AppFileEventDto>("file:deleted", handleEvent),
  ]).then((unlisteners) => () => {
    for (const unlisten of unlisteners) unlisten();
  });
}

export function listenAppVariablesChanged(
  onChange: () => void,
): Promise<() => void> {
  return listen<void>("app-settings:variables-changed", () => onChange());
}

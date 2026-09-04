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
    }
  | {
      status: "unavailable";
      ownerDirectory: string;
      runtimeType: AppRuntimeTypeDto;
      reason: string;
      browserUrl?: string;
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

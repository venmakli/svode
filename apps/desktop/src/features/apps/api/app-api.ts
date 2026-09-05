import {
  controlAppProcess as controlAppProcessDto,
  inspectAppManifest as inspectAppManifestDto,
  listenAppManifestChanges as listenAppManifestChangesDto,
  openAppOwnerDirectory as openAppOwnerDirectoryDto,
  openAppUrlInBrowser as openAppUrlInBrowserDto,
  revokeAppSource as revokeAppSourceDto,
} from "@/platform/apps/apps-api";
import type {
  AppManifestInspection,
  AppOwner,
  AppProcessControlAction,
} from "../model/types";

export function controlAppProcess(
  owner: AppOwner,
  action: AppProcessControlAction,
): Promise<AppManifestInspection> {
  return controlAppProcessDto(owner, action);
}

export async function inspectAppManifest(
  owner: AppOwner,
): Promise<AppManifestInspection> {
  return inspectAppManifestDto(owner);
}

export function listenAppManifestChanges(
  owner: AppOwner,
  onChange: () => void,
): Promise<() => void> {
  return listenAppManifestChangesDto(owner, onChange);
}

export function openAppOwnerDirectory(owner: AppOwner): Promise<void> {
  return openAppOwnerDirectoryDto(owner);
}

export function openAppUrlInBrowser(url: string): Promise<void> {
  return openAppUrlInBrowserDto(url);
}

export function revokeAppSource(capabilityToken: string): Promise<void> {
  return revokeAppSourceDto(capabilityToken);
}

import {
  resolveAssetAbsPath,
  toWebviewAssetUrl,
} from "@/platform/assets/assets-api";
import {
  filesToFileList,
  managedSourcePathForFile,
  pickManagedMediaFiles,
} from "@/platform/filesystem/native-file-picker";
import { openPath } from "@/platform/native/shell";
import type { MediaKind } from "@/platform/upload/media-types";
import {
  importManagedAttachment,
  type ManagedImportResultDto,
} from "@/platform/attachments/attachments-api";

import type { EditorAssetResolveContext } from "../lib/editor-asset-context";
import { resolveEditorAssetContext } from "../lib/editor-asset-context";

const EXTERNAL = /^(https?:|data:|blob:|asset:|file:)/i;

export { filesToFileList };
export type { ManagedImportResultDto };

export function pickEditorMediaFiles(kind: MediaKind): Promise<File[]> {
  return pickManagedMediaFiles(kind);
}

export function sourcePathForEditorMediaFile(file: File): string | null {
  return managedSourcePathForFile(file);
}

export function importEditorMediaAsset(
  input: Parameters<typeof importManagedAttachment>[0],
): Promise<ManagedImportResultDto> {
  return importManagedAttachment(input);
}

export async function resolveEditorAssetWebviewUrl(
  url: string,
  projectPath: string,
  documentAbsPath: string,
): Promise<string> {
  const abs = await resolveAssetAbsPath(url, projectPath, documentAbsPath);
  return toWebviewAssetUrl(abs);
}

export function toEditorWebviewAssetUrl(absPath: string): string {
  return toWebviewAssetUrl(absPath);
}

export async function openEditorMediaUrl(
  url: string,
  context?: EditorAssetResolveContext | null,
) {
  if (EXTERNAL.test(url)) {
    await openPath(url);
    return;
  }

  const explicitContext = resolveEditorAssetContext(context);
  if (!explicitContext) return;

  const abs = await resolveAssetAbsPath(
    url,
    explicitContext.projectPath,
    explicitContext.documentAbsPath,
  );
  await openPath(abs);
}

import {
  resolveAssetAbsPath,
  toWebviewAssetUrl,
} from "@/platform/assets/assets-api";
import {
  filesToFileList,
  pickMediaFiles,
} from "@/platform/filesystem/native-file-picker";
import { openPath } from "@/platform/native/shell";
import type { MediaKind } from "@/platform/upload/media-types";
import {
  uploadAsset,
  type UploadAssetDto,
} from "@/platform/upload/upload-api";

import type { EditorAssetResolveContext } from "../lib/editor-asset-context";
import { resolveEditorAssetContext } from "../lib/editor-asset-context";

const EXTERNAL = /^(https?:|data:|blob:|asset:|file:)/i;

export { filesToFileList };
export type { UploadAssetDto };

export function pickEditorMediaFiles(kind: MediaKind): Promise<File[]> {
  return pickMediaFiles(kind);
}

export function uploadEditorMediaAsset(
  input: Parameters<typeof uploadAsset>[0],
): Promise<UploadAssetDto> {
  return uploadAsset(input);
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

import type { PageCover } from "../model/types";
import { toWebviewAssetUrl } from "@/platform/assets/assets-api";
import { pickMediaFiles } from "@/platform/filesystem/native-file-picker";
import { uploadAsset } from "@/platform/upload/upload-api";
import {
  coverImageAbsPath,
  coverPathForUploadedAsset,
  joinAbs,
} from "../lib/cover-paths";

interface UploadCoverImageInput {
  file: File;
  projectPath: string;
  spacePath: string;
  pagePath: string;
}

export async function uploadCoverImage({
  file,
  projectPath,
  spacePath,
  pagePath,
}: UploadCoverImageInput): Promise<PageCover> {
  const buffer = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  const documentAbsPath = pagePath.startsWith("/")
    ? pagePath
    : joinAbs(spacePath, pagePath);
  const result = await uploadAsset({
    projectPath,
    documentAbsPath,
    fileName: file.name,
    bytes,
    documentId: pagePath,
  });
  const assetOwnerPath = result.spaceId ? spacePath : projectPath;

  return {
    type: "image",
    path: coverPathForUploadedAsset({
      spacePath,
      assetOwnerPath,
      assetRelPath: result.relPath,
    }),
    position: 50,
  };
}

export async function pickCoverImageFile(): Promise<File | null> {
  const files = await pickMediaFiles("image", false);
  return files[0] ?? null;
}

export function getCoverImageSrc(spacePath: string, coverPath: string): string {
  return toWebviewAssetUrl(coverImageAbsPath(spacePath, coverPath));
}

import type { EntryCover } from "@/features/entry";
import { toWebviewAssetUrl } from "@/platform/assets/assets-api";
import { uploadAsset } from "@/platform/upload/upload-api";

import { joinAbs } from "../lib/doc-link-utils";

interface UploadCoverImageInput {
  file: File;
  projectPath: string;
  spacePath: string;
  documentPath: string;
}

export async function uploadCoverImage({
  file,
  projectPath,
  spacePath,
  documentPath,
}: UploadCoverImageInput): Promise<EntryCover> {
  const buffer = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  const documentAbsPath = documentPath.startsWith("/")
    ? documentPath
    : joinAbs(spacePath, documentPath);
  const result = await uploadAsset({
    projectPath,
    documentAbsPath,
    fileName: file.name,
    bytes,
    documentId: documentPath,
  });

  return {
    type: "image",
    path: result.relPath,
    position: 50,
  };
}

export function getCoverImageSrc(spacePath: string, coverPath: string): string {
  return toWebviewAssetUrl(joinAbs(spacePath, coverPath));
}

import { invokeCommand } from "@/platform/native/invoke";

export interface UploadAssetDto {
  spaceId: string | null;
  relPath: string;
  fileName: string;
  sizeBytes: number;
  mime: string;
}

export interface UploadAssetInput {
  projectPath: string;
  documentAbsPath: string;
  fileName: string;
  bytes: number[];
  documentId: string;
}

export function uploadAsset(input: UploadAssetInput): Promise<UploadAssetDto> {
  return invokeCommand<UploadAssetDto>("upload_asset", { ...input });
}

import * as React from "react";

import { toast } from "sonner";

import { joinAbs, makeRelativeDocUrl } from "../lib/doc-link-utils";
import { uploadAsset, type UploadAssetDto } from "@/platform/upload/upload-api";
import { useEntrySelectionStore } from "@/features/entry";
import { getSpaceSnapshot } from "@/features/space";

/**
 * Shape returned by `useUploadFile` — matches the subset of Plate's
 * `UploadedFile` contract that the media node components consume. The `url`
 * is the markdown link path the editor stores in the node: relative to the
 * source document and routed through `make_relative_link` so cross-space
 * uploads (when they land) render as `../other-space/.assets/x.png`.
 */
export interface UploadedFile {
  key: string;
  url: string;
  name: string;
  size: number;
  type: string;
}

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
}

/**
 * Tauri-backed upload hook. Reads the file's bytes, ships them to the
 * `upload_asset` IPC, and returns a record whose `url` is the markdown link
 * Plate writes into the document body. The editor resolves that link back to
 * an absolute filesystem path at render time via `useResolvedAssetUrl`.
 */
export function useUploadFile({ onUploadComplete, onUploadError }: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  async function uploadFile(file: File): Promise<UploadedFile | undefined> {
    const projectPath = getSpaceSnapshot().activeRootPath;
    if (!projectPath) {
      const err = new Error("No active project");
      toast.error(err.message);
      onUploadError?.(err);
      return undefined;
    }
    // Snapshot the active document at upload initiation. If the user switches
    // documents while `file.arrayBuffer()` is resolving, we still attribute
    // the asset to the document where the upload was started.
    const { activeDocument, activeDocumentSpaceId } =
      useEntrySelectionStore.getState();
    if (!activeDocument) {
      const err = new Error("No active document");
      toast.error(err.message);
      onUploadError?.(err);
      return undefined;
    }
    const { rootSpaces, spaces, activeRootId } = getSpaceSnapshot();
    const ownerSpacePath =
      !activeDocumentSpaceId || activeDocumentSpaceId === activeRootId
        ? rootSpaces.find((r) => r.id === activeDocumentSpaceId)?.path ??
          projectPath
        : spaces.find((s) => s.id === activeDocumentSpaceId)?.path;
    if (!ownerSpacePath) {
      const err = new Error("Active document's space is unavailable");
      toast.error(err.message);
      onUploadError?.(err);
      return undefined;
    }
    const documentAbsPath = activeDocument.startsWith("/")
      ? activeDocument
      : joinAbs(ownerSpacePath, activeDocument);

    setIsUploading(true);
    setUploadingFile(file);
    setProgress(0);

    try {
      const buffer = await file.arrayBuffer();
      // Tauri 2 accepts a plain number[] for Vec<u8> over JSON IPC. For large
      // files we eat the ~3.5x serialization overhead once — this code runs
      // rarely and on a local machine, so it's a fine trade-off vs. plumbing
      // a temp-file round-trip via tauri-plugin-fs.
      const bytes = Array.from(new Uint8Array(buffer));
      setProgress(50);

      const result: UploadAssetDto = await uploadAsset({
        projectPath,
        documentAbsPath,
        fileName: file.name,
        bytes,
        documentId: activeDocument,
      });

      setProgress(100);

      // Compute the markdown link from the source document to the asset's
      // absolute path. Backend `make_relative_link` mirrors how doc-link
      // insertion builds cross-space `../space/foo.md` paths (Ф.7); for
      // intra-space uploads (MVP, Q3=A) this collapses to `.assets/x.ext`.
      // The asset's owning space is identified by `result.spaceId` (null =
      // project root); look it up to build the abs filesystem path.
      const assetOwnerPath = result.spaceId
        ? spaces.find((s) => s.id === result.spaceId)?.path ?? ownerSpacePath
        : projectPath;
      const targetAbsPath = joinAbs(assetOwnerPath, result.relPath);
      const link = await makeRelativeDocUrl(documentAbsPath, targetAbsPath);

      const uploaded: UploadedFile = {
        key: result.relPath,
        url: link,
        name: result.fileName,
        size: result.sizeBytes,
        type: result.mime,
      };

      setUploadedFile(uploaded);
      onUploadComplete?.(uploaded);
      return uploaded;
    } catch (error) {
      const message = getErrorMessage(error);
      toast.error(message);
      onUploadError?.(error);
      return undefined;
    } finally {
      setProgress(0);
      setIsUploading(false);
      setUploadingFile(undefined);
    }
  }

  return {
    isUploading,
    progress,
    uploadedFile,
    uploadFile,
    uploadingFile,
  };
}

export function getErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "Upload failed";
}

export function showErrorToast(err: unknown) {
  toast.error(getErrorMessage(err));
}

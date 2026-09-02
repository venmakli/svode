import * as React from "react";

import { toast } from "sonner";

import {
  importEditorMediaAsset,
  sourcePathForEditorMediaFile,
} from "../api/editor-media-api";
import { useEditorDocumentContext } from "./use-resolved-asset-url";

/**
 * Shape returned by `useUploadFile` — matches the subset of Plate's
 * `UploadedFile` contract that the media node components consume. The `url`
 * is the markdown link path the editor stores in the node: relative to the
 * source document after the backend has finalized the colocated file.
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
 * Tauri-backed upload hook. It passes the native source path to the managed
 * import service and returns the markdown link only after disk finalization.
 * The editor resolves that link to a scoped filesystem URL at render time.
 */
export function useUploadFile({
  onUploadComplete,
  onUploadError,
}: UseUploadFileProps = {}) {
  const editorDocument = useEditorDocumentContext();
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  async function uploadFile(file: File): Promise<UploadedFile | undefined> {
    // Snapshot the editor-local document at upload initiation. If the user
    // switches the app selection while the native import is running, the asset still
    // belongs to the document where the upload was started.
    const uploadContext = editorDocument;
    if (!uploadContext) {
      const err = new Error("No active document");
      toast.error(err.message);
      onUploadError?.(err);
      return undefined;
    }
    const { documentPath, projectPath, sourceSpaceId } = uploadContext;
    const sourcePath = sourcePathForEditorMediaFile(file);
    if (!sourcePath) {
      const error = new Error(
        "This file has no native source path. Choose it with the editor file picker and try again.",
      );
      toast.error(error.message);
      onUploadError?.(error);
      return undefined;
    }

    setIsUploading(true);
    setUploadingFile(file);
    setProgress(0);

    try {
      await uploadContext.prepareManagedImport?.();
      setProgress(25);
      const result = await importEditorMediaAsset({
        projectPath,
        spaceId: sourceSpaceId,
        contentPath: documentPath,
        sourcePath,
        fileName: file.name,
      });
      if (result.contentPath !== documentPath) {
        uploadContext.onDocumentPathChange?.(result.contentPath);
      }
      setProgress(100);

      const uploaded: UploadedFile = {
        key: result.attachmentPath,
        url: result.markdownUrl,
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

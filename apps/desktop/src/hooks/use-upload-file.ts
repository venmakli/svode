import * as React from "react";

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { useWorkspaceStore, selectActiveWorkspacePath } from "@/stores/workspace";
import { useLayoutStore } from "@/stores/layout";

/**
 * Shape returned by `useUploadFile` — matches the subset of Plate's
 * `UploadedFile` contract that the media node components consume. The `url`
 * is the workspace-relative `.assets/<prefix>-name` path; rendering code uses
 * `useResolvedAssetUrl` to convert it into a webview-loadable URL.
 */
export interface UploadedFile {
  key: string;
  url: string;
  name: string;
  size: number;
  type: string;
}

interface BackendUploadResult {
  id: string;
  assetPath: string;
  originalName: string;
  size: number;
  mimeType: string;
  assetType: "image" | "video" | "audio" | "file";
}

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
}

/**
 * Tauri-backed upload hook. Reads the file's bytes, ships them to the
 * `upload_asset` IPC, and returns a record whose `url` is the workspace-
 * relative asset path. The rest of the editor resolves that path to a real
 * asset:// URL at render time.
 */
export function useUploadFile({ onUploadComplete, onUploadError }: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  async function uploadFile(file: File): Promise<UploadedFile | undefined> {
    const workspacePath = selectActiveWorkspacePath(useWorkspaceStore.getState());
    if (!workspacePath) {
      const err = new Error("No active workspace");
      toast.error(err.message);
      onUploadError?.(err);
      return undefined;
    }
    // Snapshot the active document at upload initiation. If the user switches
    // documents while `file.arrayBuffer()` is resolving, we still attribute the
    // asset to the document where the upload was started.
    const activeDocument = useLayoutStore.getState().activeDocument ?? undefined;

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

      const result = await invoke<BackendUploadResult>("upload_asset", {
        workspacePath,
        fileName: file.name,
        bytes,
        documentId: activeDocument,
      });

      setProgress(100);

      const uploaded: UploadedFile = {
        key: result.id,
        // Store the relative .assets/ path — consumers must pass it through
        // useResolvedAssetUrl when rendering.
        url: result.assetPath,
        name: result.originalName,
        size: result.size,
        type: result.mimeType,
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

import * as React from "react";

export type MediaKind = "image" | "video" | "audio" | "file";

export interface UploadedMediaFile {
  key: string;
  url: string;
  name: string;
  size: number;
  type: string;
}

export interface UseMediaUploadProps {
  onUploadComplete?: (file: UploadedMediaFile) => void;
  onUploadError?: (error: unknown) => void;
}

export interface MediaUploadState {
  isUploading: boolean;
  progress: number;
  uploadedFile?: UploadedMediaFile;
  uploadFile: (file: File) => Promise<UploadedMediaFile | undefined>;
  uploadingFile?: File;
}

export interface MediaAdapter {
  filesToFileList: (files: File[]) => FileList;
  getErrorMessage: (error: unknown) => string;
  openUrl: (url: string) => Promise<void>;
  pickFiles: (kind: MediaKind) => Promise<File[]>;
  useResolvedUrl: (url: string | undefined) => string | undefined;
  useUploadFile: (props?: UseMediaUploadProps) => MediaUploadState;
}

function defaultFilesToFileList(files: File[]): FileList {
  const dataTransfer = new DataTransfer();
  files.forEach((file) => dataTransfer.items.add(file));
  return dataTransfer.files;
}

function defaultGetErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Media operation failed";
}

function useDefaultResolvedUrl(url: string | undefined): string | undefined {
  return url;
}

function useDefaultUploadFile(): MediaUploadState {
  const uploadFile = React.useCallback(async () => undefined, []);

  return React.useMemo(
    () => ({
      isUploading: false,
      progress: 0,
      uploadFile,
    }),
    [uploadFile],
  );
}

export const defaultMediaAdapter: MediaAdapter = {
  filesToFileList: defaultFilesToFileList,
  getErrorMessage: defaultGetErrorMessage,
  openUrl: async (url) => {
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  },
  pickFiles: async () => [],
  useResolvedUrl: useDefaultResolvedUrl,
  useUploadFile: useDefaultUploadFile,
};

const MediaAdapterContext =
  React.createContext<MediaAdapter>(defaultMediaAdapter);

export function MediaAdapterProvider({
  adapter,
  children,
}: {
  adapter: MediaAdapter;
  children: React.ReactNode;
}) {
  return (
    <MediaAdapterContext.Provider value={adapter}>
      {children}
    </MediaAdapterContext.Provider>
  );
}

export function useMediaAdapter(): MediaAdapter {
  return React.useContext(MediaAdapterContext);
}

export function useResolvedMediaUrl(
  url: string | undefined,
): string | undefined {
  return useMediaAdapter().useResolvedUrl(url);
}

export function useMediaUpload(props?: UseMediaUploadProps): MediaUploadState {
  return useMediaAdapter().useUploadFile(props);
}

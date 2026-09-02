import { toast } from "sonner";

import { inspectManagedImportSource } from "@/platform/attachments/attachments-api";
import { openDialog } from "@/platform/native/dialog";
import { invokeCommand } from "@/platform/native/invoke";
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  MANAGED_ATTACHMENT_EXTS,
  type MediaKind,
  VIDEO_EXTS,
} from "@/platform/upload/media-types";

interface LocalFileDataDto {
  name: string;
  bytes: number[];
  mimeType: string;
}

const stripDot = (ext: string) => ext.replace(/^\./, "");

const FILTERS: Record<MediaKind, { name: string; extensions: string[] }> = {
  image: { name: "Images", extensions: IMAGE_EXTS.map(stripDot) },
  video: { name: "Videos", extensions: VIDEO_EXTS.map(stripDot) },
  audio: { name: "Audio", extensions: AUDIO_EXTS.map(stripDot) },
  file: {
    name: "Documents and media",
    extensions: MANAGED_ATTACHMENT_EXTS.map(stripDot),
  },
};

export async function pickMediaFiles(
  kind: MediaKind,
  multiple = true,
): Promise<File[]> {
  const filter = FILTERS[kind];

  const selection = await openDialog({
    multiple,
    directory: false,
    filters: [filter],
  });

  if (!selection) return [];

  const paths = Array.isArray(selection) ? selection : [selection];
  const files: File[] = [];

  for (const path of paths) {
    try {
      const data = await invokeCommand<LocalFileDataDto>(
        "read_file_for_upload",
        {
          path,
        },
      );
      const bytes = new Uint8Array(data.bytes);
      files.push(new File([bytes], data.name, { type: data.mimeType }));
    } catch (err) {
      const name = path.split("/").pop() ?? path;
      toast.error(
        `Failed to read ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return files;
}

export async function pickMediaFilePaths(
  kind: MediaKind,
  multiple = true,
): Promise<string[]> {
  const filter = FILTERS[kind];
  const selection = await openDialog({
    multiple,
    directory: false,
    filters: [filter],
  });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

const managedSourcePathByFile = new WeakMap<File, string>();

export async function pickManagedMediaFiles(
  kind: MediaKind,
  multiple = true,
): Promise<File[]> {
  const paths = await pickMediaFilePaths(kind, multiple);
  const files: File[] = [];
  for (const path of paths) {
    try {
      const info = await inspectManagedImportSource(path);
      files.push(managedSourceFile(path, info));
    } catch (error) {
      const name = path.split(/[\\/]/u).pop() ?? path;
      toast.error(
        `Failed to inspect ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return files;
}

export function managedSourceFile(
  sourcePath: string,
  info: { name: string; sizeBytes: number; mime: string },
): File {
  const file = new File([], info.name, { type: info.mime });
  try {
    Object.defineProperty(file, "size", { value: info.sizeBytes });
  } catch {
    // Some WebViews keep Blob.size non-configurable. The backend remains
    // authoritative for source size and streams the path disk-to-disk.
  }
  managedSourcePathByFile.set(file, sourcePath);
  return file;
}

export function managedSourcePathForFile(file: File): string | null {
  return managedSourcePathByFile.get(file) ?? null;
}

export async function pickDirectory(): Promise<string | null> {
  const selection = await openDialog({
    directory: true,
    multiple: false,
  });

  return typeof selection === "string" ? selection : null;
}

export function filesToFileList(files: File[]): FileList {
  const list = [...files] as unknown as FileList;
  Object.defineProperty(list, "item", {
    value: (index: number) => files[index] ?? null,
  });
  return list;
}

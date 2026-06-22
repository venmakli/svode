import { toast } from "sonner";

import { openDialog } from "@/platform/native/dialog";
import { invokeCommand } from "@/platform/native/invoke";
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  type MediaKind,
  VIDEO_EXTS,
} from "@/platform/upload/media-types";

interface LocalFileDataDto {
  name: string;
  bytes: number[];
  mimeType: string;
}

const stripDot = (ext: string) => ext.replace(/^\./, "");

const FILTERS: Record<
  Exclude<MediaKind, "file">,
  { name: string; extensions: string[] }
> = {
  image: { name: "Images", extensions: IMAGE_EXTS.map(stripDot) },
  video: { name: "Videos", extensions: VIDEO_EXTS.map(stripDot) },
  audio: { name: "Audio", extensions: AUDIO_EXTS.map(stripDot) },
};

export async function pickMediaFiles(
  kind: MediaKind,
  multiple = true,
): Promise<File[]> {
  const filter = kind === "file" ? undefined : FILTERS[kind];

  const selection = await openDialog({
    multiple,
    directory: false,
    filters: filter ? [filter] : undefined,
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

export async function pickDirectory(): Promise<string | null> {
  const selection = await openDialog({
    directory: true,
    multiple: false,
  });

  return typeof selection === "string" ? selection : null;
}

export function filesToFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  files.forEach((file) => dt.items.add(file));
  return dt.files;
}

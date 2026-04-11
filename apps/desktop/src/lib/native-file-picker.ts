/**
 * Native file picker for Tauri — the only reliable way to filter file types
 * in a Tauri 2 app.
 *
 * Why: WKWebView on macOS silently ignores the `<input type="file" accept>`
 * attribute. The WKWebView APIs to read accepted file types from
 * `WKOpenPanelParameters` are private (`_acceptedMIMETypes`,
 * `_acceptedFileExtensions`) and would block App Store review, so wry does
 * not wire them up. As a result, any browser-based file picker (raw input,
 * `use-file-picker`, Plate's built-in helpers) shows *all* files regardless
 * of `accept`. See https://github.com/tauri-apps/tauri/issues/9158.
 *
 * The fix: use `@tauri-apps/plugin-dialog`'s `open()` — on macOS this goes
 * through `NSOpenPanel.allowedContentTypes` which honors the extension
 * list. The user picks a path, we pull the bytes through the
 * `read_file_for_upload` IPC and construct a browser `File` so the rest of
 * the editor (Plate's placeholder flow, `useUploadFile`) keeps working
 * unchanged.
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';

import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  type MediaKind,
  VIDEO_EXTS,
} from './media-types';

interface LocalFileData {
  name: string;
  // Rust `Vec<u8>` serializes as a JSON number array over Tauri IPC.
  bytes: number[];
  mimeType: string;
}

// `@tauri-apps/plugin-dialog` expects extensions without a leading dot.
const stripDot = (ext: string) => ext.replace(/^\./, '');

const FILTERS: Record<
  Exclude<MediaKind, 'file'>,
  { name: string; extensions: string[] }
> = {
  image: { name: 'Images', extensions: IMAGE_EXTS.map(stripDot) },
  video: { name: 'Videos', extensions: VIDEO_EXTS.map(stripDot) },
  audio: { name: 'Audio', extensions: AUDIO_EXTS.map(stripDot) },
};

/**
 * Open a native file picker filtered by the given media kind and return a
 * list of browser `File` objects loaded with the file bytes.
 *
 * `kind === 'file'` uses no filter (catch-all for the File node type).
 *
 * Returns an empty array when the user cancels the dialog.
 */
export async function pickMediaFiles(
  kind: MediaKind,
  multiple = true
): Promise<File[]> {
  const filter = kind === 'file' ? undefined : FILTERS[kind];

  const selection = await open({
    multiple,
    directory: false,
    filters: filter ? [filter] : undefined,
  });

  if (!selection) return [];

  const paths = Array.isArray(selection) ? selection : [selection];
  const files: File[] = [];

  for (const path of paths) {
    try {
      const data = await invoke<LocalFileData>('read_file_for_upload', {
        path,
      });
      // `new File([Uint8Array], ...)` wraps the buffer by reference; the
      // subsequent `file.arrayBuffer()` inside `useUploadFile` does not copy.
      const bytes = new Uint8Array(data.bytes);
      files.push(
        new File([bytes], data.name, { type: data.mimeType })
      );
    } catch (err) {
      const name = path.split('/').pop() ?? path;
      toast.error(
        `Failed to read ${name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return files;
}

/**
 * Convert an array of `File` objects into a `FileList`, which is what
 * Plate's `insert.media` transform expects. `DataTransfer` is the only
 * standard-compliant way to construct a `FileList`.
 */
export function filesToFileList(files: File[]): FileList {
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  return dt.files;
}

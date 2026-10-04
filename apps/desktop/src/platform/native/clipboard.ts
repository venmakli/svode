import { invokeCommand } from "@/platform/native/invoke";

const FILE_NAME_HEADER = "x-svode-drop-file-name";

/** Files copied in the file manager, by path; empty where the OS gives none. */
export function readClipboardFilePaths(): Promise<string[]> {
  return invokeCommand<string[]>("native_clipboard_file_paths");
}

/**
 * Writes an image pasted without a path into the system temp directory
 * and resolves to the file's absolute path.
 */
export async function savePastedImage(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invokeCommand<string>("save_pasted_image", bytes, {
    headers: { [FILE_NAME_HEADER]: encodeURIComponent(file.name) },
  });
}

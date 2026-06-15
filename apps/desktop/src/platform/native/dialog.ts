import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog";

export type { OpenDialogOptions };

export function openDialog(options?: OpenDialogOptions) {
  return open(options);
}

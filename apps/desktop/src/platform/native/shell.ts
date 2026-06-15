import { open } from "@tauri-apps/plugin-shell";

export function openPath(path: string) {
  return open(path);
}

import { getCurrentWindow } from "@tauri-apps/api/window";

export function getCurrentAppWindow() {
  return getCurrentWindow();
}

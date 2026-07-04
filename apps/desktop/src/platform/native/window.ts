import { getCurrentWindow } from "@tauri-apps/api/window";

export function getCurrentAppWindow() {
  return getCurrentWindow();
}

export function setCurrentAppWindowTitle(title: string): Promise<void> {
  return getCurrentWindow().setTitle(title);
}

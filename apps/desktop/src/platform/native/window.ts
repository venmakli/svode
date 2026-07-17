import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCommand } from "./invoke";

export function getCurrentAppWindow() {
  return getCurrentWindow();
}

export function setCurrentAppWindowTitle(title: string): Promise<void> {
  return invokeCommand<void>("set_current_window_title", { title });
}

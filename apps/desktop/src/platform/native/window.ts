import { getCurrentWindow } from "@tauri-apps/api/window";
import { invokeCommand } from "./invoke";

const TRAFFIC_LIGHT_INSET_EVENT = "native-window:traffic-light-inset";

export function setCurrentAppWindowTitle(title: string): Promise<void> {
  return invokeCommand<void>("set_current_window_title", { title });
}

export function isCurrentAppWindowFullscreen(): Promise<boolean> {
  return getCurrentWindow().isFullscreen();
}

export function listenCurrentAppWindowTrafficLightInset(
  listener: (reserved: boolean) => void,
) {
  return getCurrentWindow().listen<boolean>(
    TRAFFIC_LIGHT_INSET_EVENT,
    (event) => listener(event.payload),
  );
}

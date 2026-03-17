import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();

    appWindow.isFullscreen().then(setIsFullscreen);

    const unlisten = appWindow.onResized(async () => {
      const fs = await appWindow.isFullscreen();
      setIsFullscreen(fs);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return isFullscreen;
}

import { useState, useEffect } from "react";
import { getCurrentAppWindow } from "@/platform/native/window";

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentAppWindow();

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

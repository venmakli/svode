import { useEffect } from "react";
import { setRootProjectLauncherWindowTitle } from "../api/root-project-actions";

export function useRootProjectWindowTitle() {
  useEffect(() => {
    void setRootProjectLauncherWindowTitle().catch((err) =>
      console.warn("set window title failed:", err),
    );
  }, []);
}

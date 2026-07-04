import { useEffect } from "react";
import { listenRootProjectOpenFolderRequest } from "../api/root-project-actions";
import { useRootProjectWorkflow } from "../hooks/use-root-project-workflow";

export function RootProjectMenuBridge() {
  const { handleOpenProjectFolder } = useRootProjectWorkflow();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listenRootProjectOpenFolderRequest(() => {
      void handleOpenProjectFolder();
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((err) =>
        console.warn("listen app-menu:open-folder failed:", err),
      );

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleOpenProjectFolder]);

  return null;
}

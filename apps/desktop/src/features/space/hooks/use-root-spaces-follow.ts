import { useEffect } from "react";
import { listenRootSpacesChanged } from "../api/space-store-actions";
import { useSpaceStore } from "../model/space-store";

/**
 * The projects of Home and of the project switcher follow the list of the
 * device when another process or window changes it.
 */
export function useRootSpacesFollow() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenRootSpacesChanged(
      () => void useSpaceStore.getState().refreshRootSpaces(),
    )
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((err) => console.warn("listen projects:changed failed:", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

import { useEffect } from "react";
import { listenGlobalIdentityChanged } from "../api";
import { useIdentityStore } from "../model";

/**
 * On mount, load the global git identity. The root component reads
 * `loaded` and `source` from the store to decide whether to show a splash,
 * the identity dialog, or the actual app.
 */
export function useIdentityCheck() {
  const load = useIdentityStore((s) => s.load);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const reconcileIdentity = () => {
      void load().catch((error) => {
        console.error("load global identity failed:", error);
      });
    };
    const handleFocus = () => reconcileIdentity();

    window.addEventListener("focus", handleFocus);
    void listenGlobalIdentityChanged(() => {
      if (!disposed) reconcileIdentity();
    })
      .then((nextUnlisten) => {
        if (disposed) {
          void nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("Failed to subscribe to global identity changes:", error);
      })
      .finally(() => {
        if (!disposed) reconcileIdentity();
      });

    return () => {
      disposed = true;
      window.removeEventListener("focus", handleFocus);
      if (unlisten) void unlisten();
    };
  }, [load]);
}

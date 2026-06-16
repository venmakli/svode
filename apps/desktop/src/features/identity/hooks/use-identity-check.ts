import { useEffect } from "react";
import { useIdentityStore } from "../model";

/**
 * On mount, load the global git identity. The root component reads
 * `loaded` and `source` from the store to decide whether to show a splash,
 * the identity dialog, or the actual app.
 */
export function useIdentityCheck() {
  const load = useIdentityStore((s) => s.load);
  const loaded = useIdentityStore((s) => s.loaded);

  useEffect(() => {
    if (loaded) return;
    void load().catch((err) => {
      console.error("get_git_identity failed:", err);
    });
  }, [load, loaded]);
}

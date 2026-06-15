import { useEffect, useState } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { useSpaceStore, selectActiveSpacePath } from "@/stores/space";
import { useIdentityStore } from "./identity-store";
import type { GitIdentity, RepoIdentityResult } from "./types";

interface EffectiveIdentity {
  name: string | null;
  email: string | null;
  loading: boolean;
}

/**
 * Effective git identity for the active space (with natural nested → root
 * fallback via `selectActiveSpacePath`). Re-fetches when the active path
 * changes or after any Save bumps `refreshVersion`. Empty path (Home) →
 * global identity from the store.
 */
export function useEffectiveIdentity(): EffectiveIdentity {
  const spacePath = useSpaceStore(selectActiveSpacePath);
  const global = useIdentityStore((s) => s.global);
  const refreshVersion = useIdentityStore((s) => s.refreshVersion);
  const [identity, setIdentity] = useState<GitIdentity | null>(global);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!spacePath) {
      setIdentity(global);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const result = await invoke<RepoIdentityResult>("get_repo_identity", {
          repoPath: spacePath,
        });
        if (cancelled) return;
        setIdentity(result.effective ?? global);
      } catch (err) {
        if (!cancelled) {
          console.warn("get_repo_identity failed:", err);
          setIdentity(global);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spacePath, global, refreshVersion]);

  return {
    name: identity?.name ?? null,
    email: identity?.email ?? null,
    loading,
  };
}

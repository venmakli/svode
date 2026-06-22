import { useEffect, useState } from "react";
import { useSpace, selectActiveSpacePath } from "@/features/space";
import { getRepoIdentity } from "../api";
import { useIdentityStore } from "../model";
import type { GitIdentity, RepoIdentityResult } from "../model";

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
  const spacePath = useSpace(selectActiveSpacePath);
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
        const result: RepoIdentityResult = await getRepoIdentity(spacePath);
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

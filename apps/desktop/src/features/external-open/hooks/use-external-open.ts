import { useCallback, useEffect, useRef, useState } from "react";

import { readPreferredApp, writePreferredApp } from "../api/preferences";
import { resolvePrimaryApp } from "../model/primary-app";
import type { ExternalApp, ExternalOpenTarget } from "../model/types";

/**
 * Applications, remembered choice and launch state for one target. Mount a
 * fresh instance (e.g. with `key`) when the target changes.
 */
export function useExternalOpen(
  target: ExternalOpenTarget,
  onError: (error: unknown, app: ExternalApp | null) => void,
) {
  const [apps, setApps] = useState<readonly ExternalApp[]>([]);
  const [preferredId, setPreferredId] = useState(() =>
    readPreferredApp(target.preferenceKey),
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const latestRequest = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    target.listApps().then(
      (next) => {
        if (request === latestRequest.current) setApps(next);
      },
      (error: unknown) => {
        console.error("Failed to list external applications:", error);
      },
    );
  }, [target]);

  useEffect(() => {
    refresh();
    return () => {
      latestRequest.current += 1;
    };
  }, [refresh]);

  const primary = resolvePrimaryApp(apps, preferredId);

  const open = useCallback(
    async (app: ExternalApp | null) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        await target.open(app?.id ?? null);
      } catch (error) {
        onError(error, app);
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [onError, target],
  );

  const openApp = useCallback(
    (app: ExternalApp) => {
      if (pendingRef.current) return Promise.resolve();
      writePreferredApp(target.preferenceKey, app.id);
      setPreferredId(app.id);
      return open(app);
    },
    [open, target.preferenceKey],
  );

  return {
    apps,
    primary,
    pending,
    refresh,
    /** Opens in the primary application without changing the remembered choice. */
    openPrimary: () => open(primary),
    /** Opens in an explicitly chosen application and remembers it for this kind of target. */
    openApp,
  };
}

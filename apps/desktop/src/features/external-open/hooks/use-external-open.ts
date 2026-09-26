import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  readPreferredApp,
  subscribePreferredApps,
  writePreferredApp,
} from "../api/preferences";
import { resolvePrimaryApp } from "../model/primary-app";
import type { ExternalApp, ExternalOpenTarget } from "../model/types";

interface AppListing {
  target: ExternalOpenTarget;
  apps: readonly ExternalApp[];
}

/** Applications, remembered choice and launch state for one target. */
export function useExternalOpen(
  target: ExternalOpenTarget,
  onError: (error: unknown, app: ExternalApp | null) => void,
) {
  const [listing, setListing] = useState<AppListing | null>(null);
  const readPreferred = () => readPreferredApp(target.preferenceKey);
  const preferredId = useSyncExternalStore(
    subscribePreferredApps,
    readPreferred,
    readPreferred,
  );
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const latestRequest = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    target.listApps().then(
      (apps) => {
        if (request === latestRequest.current) setListing({ target, apps });
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

  // A listing of a previous target is never shown for the current one.
  const apps = listing?.target === target ? listing.apps : null;
  const primary = resolvePrimaryApp(apps ?? [], preferredId);

  const run = useCallback(
    async (action: () => Promise<void>, app: ExternalApp | null) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        await action();
      } catch (error) {
        onError(error, app);
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [onError],
  );

  const choose = useCallback(
    (app: ExternalApp | null) => {
      if (pendingRef.current) return Promise.resolve();
      writePreferredApp(target.preferenceKey, app?.id ?? null);
      return run(() => target.open(app?.id ?? null), app);
    },
    [run, target],
  );

  const reveal = target.reveal;

  return {
    apps: apps ?? [],
    /** The OS offered no default application, so the generic OS choice stands in for it. */
    withoutDefault: apps !== null && !apps.some((app) => app.isDefault),
    primary,
    pending,
    refresh,
    /** Opens in the primary application without changing the remembered choice. */
    openPrimary: () => run(() => target.open(primary?.id ?? null), primary),
    /**
     * Opens in an explicitly chosen application — `null` for the generic OS
     * choice — and remembers it for this kind of target.
     */
    choose,
    reveal: reveal ? () => run(() => reveal.call(target), null) : undefined,
  };
}

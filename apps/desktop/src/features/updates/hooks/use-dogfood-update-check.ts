import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPath } from "@/platform/native/shell";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { fetchDogfoodFeed } from "../api/dogfood-feed";
import { getCurrentUpdatePlatform } from "../api/environment";
import {
  type AvailableDogfoodUpdate,
  selectDogfoodUpdate,
} from "../model";

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "svode.updates.dogfood.lastCheckAt";
const LAST_NOTIFIED_KEY = "svode.updates.dogfood.lastNotifiedId";

type UpdateCheckStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "error";

interface UseDogfoodUpdateCheckOptions {
  currentVersion: string;
  currentBuildCommit: string;
  auto?: boolean;
}

interface CheckOptions {
  silent?: boolean;
  force?: boolean;
}

export function useDogfoodUpdateCheck({
  currentVersion,
  currentBuildCommit,
  auto = false,
}: UseDogfoodUpdateCheckOptions) {
  const [status, setStatus] = useState<UpdateCheckStatus>("idle");
  const [update, setUpdate] = useState<AvailableDogfoodUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoAttempted = useRef(false);
  const platform = useMemo(() => getCurrentUpdatePlatform(), []);

  const openUpdate = useCallback(async (available: AvailableDogfoodUpdate) => {
    const targetUrl =
      available.platformUpdate.url || available.platformUpdate.fallbackUrl;
    if (!targetUrl) return;

    try {
      await openPath(targetUrl);
    } catch (err) {
      console.error("Failed to open update URL:", err);
      if (available.platformUpdate.fallbackUrl) {
        try {
          await openPath(available.platformUpdate.fallbackUrl);
          return;
        } catch (fallbackErr) {
          console.error("Failed to open fallback update URL:", fallbackErr);
        }
      }
      toast.error(m.updates_open_failed());
    }
  }, []);

  const check = useCallback(
    async ({ silent = false, force = false }: CheckOptions = {}) => {
      if (!currentVersion) return null;
      if (silent && !force && !shouldCheckNow()) return update;

      setStatus("checking");
      setError(null);

      try {
        const feed = await fetchDogfoodFeed();
        const available = selectDogfoodUpdate(
          feed,
          {
            version: currentVersion,
            commit: currentBuildCommit,
          },
          platform,
          Date.now(),
        );
        writeStorage(LAST_CHECK_KEY, String(Date.now()));

        if (!available) {
          setUpdate(null);
          setStatus("current");
          if (!silent) toast.success(m.updates_no_updates());
          return null;
        }

        setUpdate(available);
        setStatus("available");

        const lastNotifiedId = readStorage(LAST_NOTIFIED_KEY);
        if (!silent || lastNotifiedId !== available.id) {
          toast.info(updateTitle(available), {
            description: updateDescription(available),
            action: {
              label: m.updates_download(),
              onClick: () => {
                void openUpdate(available);
              },
            },
          });
          if (silent) writeStorage(LAST_NOTIFIED_KEY, available.id);
        }

        return available;
      } catch (err) {
        console.error("Failed to check dogfood updates:", err);
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
        if (!silent) toast.error(m.updates_check_failed());
        return null;
      }
    },
    [currentBuildCommit, currentVersion, openUpdate, platform, update],
  );

  useEffect(() => {
    if (!auto || autoAttempted.current || !currentVersion) return;
    autoAttempted.current = true;
    const timeout = window.setTimeout(() => {
      void check({ silent: true });
    }, 5000);
    return () => window.clearTimeout(timeout);
  }, [auto, check, currentVersion]);

  return {
    status,
    update,
    error,
    checking: status === "checking",
    check,
    openUpdate,
  };
}

function shouldCheckNow(): boolean {
  const lastCheck = Number.parseInt(readStorage(LAST_CHECK_KEY) ?? "", 10);
  if (!Number.isFinite(lastCheck)) return true;
  return Date.now() - lastCheck >= CHECK_INTERVAL_MS;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; update checking should still work.
  }
}

function updateTitle(update: AvailableDogfoodUpdate): string {
  if (update.item.kind === "ci-build") {
    return m.updates_ci_build_available_title();
  }
  return m.updates_release_available_title({ version: update.item.version });
}

function updateDescription(update: AvailableDogfoodUpdate): string {
  if (update.item.kind === "ci-build") {
    return update.item.reason?.trim() || m.updates_ci_build_available_desc();
  }
  return m.updates_release_available_desc();
}

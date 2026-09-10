import { openPath } from "@/platform/native/shell";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import { fetchDogfoodFeed } from "./dogfood-feed";
import { getCurrentUpdatePlatform } from "./environment";
import { type AvailableDogfoodUpdate, selectDogfoodUpdate } from "../model";

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "svode.updates.dogfood.lastCheckAt";
const LAST_NOTIFIED_KEY = "svode.updates.dogfood.lastNotifiedId";

interface UpdateSnapshot {
  status: "idle" | "checking" | "current" | "available" | "error";
  update: AvailableDogfoodUpdate | null;
  error: string | null;
}

export function createDogfoodUpdateRuntime(version: string, commit: string) {
  let snapshot: UpdateSnapshot = { status: "idle", update: null, error: null };
  const listeners = new Set<() => void>();
  const platform = getCurrentUpdatePlatform();
  let activeCheck: AbortController | null = null;
  let lifetime: AbortController | null = null;
  let autoAttempted = false;
  let availableToast: string | number | undefined;

  function publish(next: UpdateSnapshot) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function dismissAvailableToast() {
    if (availableToast !== undefined) toast.dismiss(availableToast);
    availableToast = undefined;
  }

  async function openUpdate() {
    const available = snapshot.update;
    const scope = lifetime;
    if (!available || !scope || scope.signal.aborted) return;
    const { url, fallbackUrl } = available.platformUpdate;
    try {
      await openPath(url);
    } catch (err) {
      if (scope.signal.aborted) return;
      console.error("Failed to open update URL:", err);
      if (fallbackUrl) {
        try {
          await openPath(fallbackUrl);
          return;
        } catch (fallbackErr) {
          if (scope.signal.aborted) return;
          console.error("Failed to open fallback update URL:", fallbackErr);
        }
      }
      toast.error(m.updates_open_failed());
    }
  }

  async function check({ silent = false }: { silent?: boolean } = {}) {
    if (!version || !lifetime || lifetime.signal.aborted || activeCheck)
      return null;
    if (silent && !shouldCheckNow()) return snapshot.update;
    const controller = new AbortController();
    activeCheck = controller;
    const isCurrent = () =>
      activeCheck === controller && !controller.signal.aborted;
    publish({ ...snapshot, status: "checking", error: null });
    try {
      const feed = await fetchDogfoodFeed(controller.signal);
      if (!isCurrent()) return null;
      const now = Date.now();
      const available = selectDogfoodUpdate(
        feed,
        { version, commit },
        platform,
        now,
      );
      writeStorage(LAST_CHECK_KEY, String(now));
      publish({
        status: available ? "available" : "current",
        update: available,
        error: null,
      });
      if (!available) {
        dismissAvailableToast();
        if (!silent) toast.success(m.updates_no_updates());
        return null;
      }
      if (!silent || readStorage(LAST_NOTIFIED_KEY) !== available.id) {
        dismissAvailableToast();
        availableToast = toast.info(updateTitle(available), {
          description: updateDescription(available),
          action: {
            label: m.updates_download(),
            onClick: () => {
              void openUpdate();
            },
          },
        });
        if (silent) writeStorage(LAST_NOTIFIED_KEY, available.id);
      }
      return available;
    } catch (err) {
      if (!isCurrent() || isAbortError(err)) return null;
      console.error("Failed to check dogfood updates:", err);
      publish({
        ...snapshot,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      if (!silent) toast.error(m.updates_check_failed());
      return null;
    } finally {
      if (activeCheck === controller) activeCheck = null;
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    openUpdate,
    canCheck: Boolean(version),
    start() {
      const scope = new AbortController();
      lifetime = scope;
      const timer =
        version && !autoAttempted
          ? window.setTimeout(() => {
              autoAttempted = true;
              void check({ silent: true });
            }, 5000)
          : undefined;
      return () => {
        scope.abort();
        if (timer !== undefined) window.clearTimeout(timer);
        activeCheck?.abort();
        activeCheck = null;
        dismissAvailableToast();
      };
    },
  };
}

function shouldCheckNow(): boolean {
  const lastCheck = Number.parseInt(readStorage(LAST_CHECK_KEY) ?? "", 10);
  if (!Number.isFinite(lastCheck)) return true;
  return Date.now() - lastCheck >= CHECK_INTERVAL_MS;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

const PREFERRED_APPS_STORAGE_KEY = "svode:external-open:preferred-apps";

type PreferredApps = Record<string, string>;

const listeners = new Set<() => void>();

function readPreferredApps(): PreferredApps {
  try {
    const raw = window.localStorage.getItem(PREFERRED_APPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function readPreferredApp(preferenceKey: string): string | null {
  return readPreferredApps()[preferenceKey] ?? null;
}

/** `null` forgets the choice, so the OS default becomes primary again. */
export function writePreferredApp(preferenceKey: string, appId: string | null) {
  const others = Object.fromEntries(
    Object.entries(readPreferredApps()).filter(
      ([key]) => key !== preferenceKey,
    ),
  );
  try {
    window.localStorage.setItem(
      PREFERRED_APPS_STORAGE_KEY,
      JSON.stringify(appId ? { ...others, [preferenceKey]: appId } : others),
    );
  } catch {
    // localStorage can be unavailable in restricted WebViews; keep runtime state.
  }
  for (const listener of listeners) listener();
}

/** Keeps every control of one kind of target on the same remembered choice. */
export function subscribePreferredApps(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

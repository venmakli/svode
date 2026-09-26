const PREFERRED_APPS_STORAGE_KEY = "svode:external-open:preferred-apps";

type PreferredApps = Record<string, string>;

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

export function writePreferredApp(preferenceKey: string, appId: string) {
  try {
    window.localStorage.setItem(
      PREFERRED_APPS_STORAGE_KEY,
      JSON.stringify({ ...readPreferredApps(), [preferenceKey]: appId }),
    );
  } catch {
    // localStorage can be unavailable in restricted WebViews; keep runtime state.
  }
}

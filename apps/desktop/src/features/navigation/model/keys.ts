import type { NavigationItemDto, NavigationKeyDto } from "../api/navigation";

export type NavigationKey = NavigationKeyDto;
export type NavigationItem = NavigationItemDto;

/** Stable identity string of a key, equal for keys that address one object. */
export function navigationKeyId(key: NavigationKey): string {
  switch (key.kind) {
    case "space":
      return JSON.stringify([key.kind, key.spaceId ?? null]);
    case "session":
      return JSON.stringify([key.kind, key.sessionId]);
    case "sessionLaunch":
      return JSON.stringify([key.kind, key.launchId]);
    default:
      return JSON.stringify([key.kind, key.spaceId ?? null, key.path]);
  }
}

export function sameNavigationKey(a: NavigationKey, b: NavigationKey): boolean {
  return navigationKeyId(a) === navigationKeyId(b);
}

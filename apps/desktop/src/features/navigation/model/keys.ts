import type {
  NavigationItemDto,
  NavigationKeyDto,
  NavigationResolvedItemDto,
} from "../api/navigation";

export type NavigationKey = NavigationKeyDto;
export type NavigationItem = NavigationItemDto;
export type NavigationResolvedItem = NavigationResolvedItemDto;
export type NavigationArtifactKind =
  | "page"
  | "collection"
  | "attachment"
  | "app";

/**
 * Stable identity string of a key, equal for keys that address one object.
 * An artifact is its Space and path, whatever form the key recorded.
 */
export function navigationKeyId(key: NavigationKey): string {
  switch (key.kind) {
    case "space":
      return JSON.stringify([key.kind, key.spaceId ?? null]);
    case "session":
      return JSON.stringify([key.kind, key.sessionId]);
    case "sessionLaunch":
      return JSON.stringify([key.kind, key.launchId]);
    default:
      return JSON.stringify(["artifact", key.spaceId ?? null, key.path]);
  }
}

export function sameNavigationKey(a: NavigationKey, b: NavigationKey): boolean {
  return navigationKeyId(a) === navigationKeyId(b);
}

/**
 * The key path of an artifact: a folder Page, Collection or App is its
 * folder, whether addressed by the directory or its README.
 */
export function navigationKeyPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 && normalized.slice(slash + 1).toLowerCase() === "readme.md"
    ? normalized.slice(0, slash)
    : normalized;
}

/**
 * The key's Space id: registered Spaces by id, the Project root without one.
 * The frontend addresses root content by the root id.
 */
function keySpaceId(
  spaceId: string | null | undefined,
  rootSpaceId: string | null,
): { spaceId?: string } {
  return spaceId && spaceId !== rootSpaceId ? { spaceId } : {};
}

export function spaceNavigationKey(
  spaceId: string | null | undefined,
  rootSpaceId: string | null,
): NavigationKey {
  return { kind: "space", ...keySpaceId(spaceId, rootSpaceId) };
}

export function artifactNavigationKey(
  kind: NavigationArtifactKind,
  path: string,
  spaceId: string | null | undefined,
  rootSpaceId: string | null,
): NavigationKey {
  return {
    kind,
    ...keySpaceId(spaceId, rootSpaceId),
    path: kind === "attachment" ? path : navigationKeyPath(path),
  };
}

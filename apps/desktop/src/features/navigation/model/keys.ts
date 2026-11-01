import type {
  NavigationItemDto,
  NavigationKeyDto,
  NavigationResolvedItemDto,
} from "../api/navigation";

export type NavigationKey = NavigationKeyDto;
export type NavigationItem = NavigationItemDto;
export type NavigationResolvedItem = NavigationResolvedItemDto;
/** The kinds of keys that address content by its Space and path. */
export type NavigationPathKeyKind = Extract<
  NavigationKey,
  { path: string }
>["kind"];
/** The kinds of keys of items of fixed Collections, which their domain resolves. */
export type NavigationItemKeyKind =
  | "routine"
  | "agentActor"
  | "person"
  | "contextItem";
export type NavigationItemKey = Extract<
  NavigationKey,
  { kind: NavigationItemKeyKind }
>;

export function isNavigationItemKey(
  key: NavigationKey,
): key is NavigationItemKey {
  return (
    key.kind === "routine" ||
    key.kind === "agentActor" ||
    key.kind === "person" ||
    key.kind === "contextItem"
  );
}

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
    case "routine":
      return JSON.stringify([
        "item",
        key.kind,
        key.spaceId ?? null,
        key.ownerPath,
        key.routineId,
      ]);
    case "agentActor":
      return JSON.stringify([
        "item",
        key.kind,
        key.spaceId ?? null,
        key.actorId,
      ]);
    case "person":
      return JSON.stringify(["item", key.kind, key.spaceId ?? null, key.email]);
    case "contextItem":
      return JSON.stringify([
        "item",
        key.kind,
        key.spaceId ?? null,
        key.itemId,
      ]);
    default:
      return JSON.stringify(["artifact", key.spaceId ?? null, key.path]);
  }
}

export function sameNavigationKey(a: NavigationKey, b: NavigationKey): boolean {
  return navigationKeyId(a) === navigationKeyId(b);
}

/**
 * Identity string of the Routine whose launch kept the item, or null: the
 * next launch of the Routine takes the row of the previous one (DF-210 R4).
 */
export function navigationRoutineId(
  item: NavigationResolvedItem,
): string | null {
  const routine = item.routine;
  return routine
    ? JSON.stringify([
        "routine",
        routine.spaceId ?? null,
        routine.ownerKind,
        routine.ownerPath,
        routine.routineId,
      ])
    : null;
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

export function pathNavigationKey(
  kind: NavigationPathKeyKind,
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

/**
 * A Routine by its owner and the id of its definition: the Project root or
 * a Space at owner path ".", a Collection by its folder.
 */
export function routineNavigationKey(
  spaceId: string | null | undefined,
  ownerPath: string,
  routineId: string,
  rootSpaceId: string | null,
): NavigationKey {
  const space = keySpaceId(spaceId, rootSpaceId);
  return {
    kind: "routine",
    ...space,
    ownerKind:
      ownerPath !== "." ? "collection" : space.spaceId ? "space" : "project",
    ownerPath,
    routineId,
  };
}

export function agentActorNavigationKey(
  spaceId: string | null | undefined,
  actorId: string,
  rootSpaceId: string | null,
): NavigationKey {
  return { kind: "agentActor", ...keySpaceId(spaceId, rootSpaceId), actorId };
}

/** A person by the canonical email in the repository of the Space. */
export function personNavigationKey(
  spaceId: string | null | undefined,
  email: string,
  rootSpaceId: string | null,
): NavigationKey {
  return { kind: "person", ...keySpaceId(spaceId, rootSpaceId), email };
}

/** An item of the "Context" by the stable id the scanner gives it in the Space. */
export function contextItemNavigationKey(
  spaceId: string | null | undefined,
  itemId: string,
  rootSpaceId: string | null,
): NavigationKey {
  return { kind: "contextItem", ...keySpaceId(spaceId, rootSpaceId), itemId };
}

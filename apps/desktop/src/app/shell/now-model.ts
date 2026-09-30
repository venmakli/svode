import {
  agentSessionForNavigationKey,
  agentSessionNavigationIndex,
  pinnableAgentSessionItem,
  type AgentSession,
} from "@/features/agent-sessions";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
  type NavigationResolvedItem,
} from "@/features/navigation";
import type { MainAreaObject } from "./main-area-object";

export interface NowTemporary {
  item: NavigationResolvedItem;
  /** How it is kept; a session without identity cannot be. */
  keepItem: NavigationItem | null;
}

export interface NowSections {
  /** Active sessions that are not pinned, in their Now order. */
  active: AgentSession[];
  /** Kept objects in keep order, except active sessions shown above. */
  kept: NavigationResolvedItem[];
  temporary: NowTemporary | null;
}

export function isSessionKey(key: NavigationKey) {
  return key.kind === "session" || key.kind === "sessionLaunch";
}

/**
 * The rows of Now. An object is shown once in Pinned and Now together:
 * Pinned first, then active sessions, kept objects and the temporary main
 * area object. A Space main page is never temporary, and an artifact is
 * temporary only once its source confirmed it (`described`).
 */
export function composeNow({
  pinned,
  kept,
  activeSessions,
  mainObject,
  described,
}: {
  pinned: readonly NavigationItem[];
  kept: readonly NavigationResolvedItem[];
  activeSessions: readonly AgentSession[];
  mainObject: MainAreaObject | null;
  described: NavigationResolvedItem | null;
}): NowSections {
  const active = activeSessions.filter(
    (session) => agentSessionNavigationIndex([...pinned], session) < 0,
  );
  return {
    active,
    kept: kept.filter(
      (item) =>
        !isSessionKey(item.key) ||
        agentSessionForNavigationKey(item.key, active) === null,
    ),
    temporary: temporaryOf(mainObject, pinned, kept, activeSessions, described),
  };
}

function temporaryOf(
  object: MainAreaObject | null,
  pinned: readonly NavigationItem[],
  kept: readonly NavigationItem[],
  activeSessions: readonly AgentSession[],
  described: NavigationResolvedItem | null,
): NowTemporary | null {
  if (!object || object.kind === "space") return null;
  const listed = [...pinned, ...kept];
  if (object.kind === "session") {
    if (activeSessions.some((session) => session.id === object.session.id)) {
      return null;
    }
    return agentSessionNavigationIndex(listed, object.session) >= 0
      ? null
      : {
          item: object.item,
          keepItem: pinnableAgentSessionItem(object.session),
        };
  }
  const id = navigationKeyId(object.item.key);
  if (!described || listed.some((item) => navigationKeyId(item.key) === id)) {
    return null;
  }
  return { item: described, keepItem: described };
}

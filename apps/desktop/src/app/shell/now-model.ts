import {
  agentSessionForNavigationKey,
  agentSessionNavigationIndex,
  agentSessionNavigationKey,
  pinnableAgentSessionItem,
  type AgentSession,
} from "@/features/agent-sessions";
import {
  navigationKeyId,
  type NavigationItem,
  type NavigationKey,
  type NavigationResolvedItem,
  type NowOrderRow,
} from "@/features/navigation";
import type { MainAreaObject } from "./main-area-object";

export interface NowTemporary {
  item: NavigationResolvedItem;
  /** How it is kept; a session without identity cannot be. */
  keepItem: NavigationItem | null;
  /** The session it shows, when it is one. */
  session: AgentSession | null;
}

/**
 * A row of Now: an active session that is not pinned, kept or not; a kept
 * object that is not an active session; or the temporary main area object.
 */
export type NowRow =
  | { kind: "active"; session: AgentSession; kept: NavigationItem | null }
  | { kind: "kept"; item: NavigationResolvedItem }
  | { kind: "temporary"; temporary: NowTemporary };

export function isSessionKey(key: NavigationKey) {
  return key.kind === "session" || key.kind === "sessionLaunch";
}

/**
 * The rows of Now in the order new rows take (DF-206 R5): kept objects in
 * keep order, then active sessions not kept, earlier activity first, then
 * the temporary main area object. An object is shown once in Pinned and
 * Now together. A Space main page is never temporary, and an artifact is
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
}): NowRow[] {
  const active = activeSessions.filter(
    (session) => agentSessionNavigationIndex([...pinned], session) < 0,
  );
  const shown = new Set<AgentSession>();
  const rows = kept.flatMap((item): NowRow[] => {
    const session = isSessionKey(item.key)
      ? agentSessionForNavigationKey(item.key, active)
      : null;
    if (!session) return [{ kind: "kept", item }];
    if (shown.has(session)) return [];
    shown.add(session);
    return [{ kind: "active", session, kept: item }];
  });
  const newcomers = active
    .filter((session) => !shown.has(session))
    .sort((left, right) => activityMs(left) - activityMs(right));
  for (const session of newcomers) {
    rows.push({ kind: "active", session, kept: null });
  }
  const temporary = temporaryOf(
    mainObject,
    pinned,
    kept,
    activeSessions,
    described,
  );
  if (temporary) rows.push({ kind: "temporary", temporary });
  return rows;
}

/** The key ids by which the Now order knows a row through its states. */
export function nowOrderRow(row: NowRow): NowOrderRow {
  switch (row.kind) {
    case "active":
      return sessionOrderRow(row.session, row.kept);
    case "kept":
      return { ids: [navigationKeyId(row.item.key)] };
    case "temporary": {
      const { item, session } = row.temporary;
      const order = session
        ? sessionOrderRow(session, null)
        : { ids: [navigationKeyId(item.key)] };
      return { ...order, temporary: true };
    }
  }
}

/**
 * A session row is one row by any of its ids and by the key it is kept by;
 * a pending session continues as the canonical one its terminal hands to.
 */
function sessionOrderRow(
  session: AgentSession,
  kept: NavigationItem | null,
): NowOrderRow {
  const keys: NavigationKey[] = [
    agentSessionNavigationKey(session),
    { kind: "session", sessionId: session.id },
    ...(session.aliasIds ?? []).map(
      (sessionId): NavigationKey => ({ kind: "session", sessionId }),
    ),
    ...(session.launchId
      ? [{ kind: "sessionLaunch", launchId: session.launchId } as const]
      : []),
    ...(kept ? [kept.key] : []),
  ];
  const ptyId = session.runtime?.ptyId;
  return {
    ids: [...new Set(keys.map(navigationKeyId))],
    links: ptyId ? [JSON.stringify(["pty", ptyId])] : [],
  };
}

function activityMs(session: AgentSession): number {
  const time = Date.parse(session.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
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
          session: object.session,
        };
  }
  const id = navigationKeyId(object.item.key);
  if (!described || listed.some((item) => navigationKeyId(item.key) === id)) {
    return null;
  }
  return { item: described, keepItem: described, session: null };
}

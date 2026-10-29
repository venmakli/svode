import {
  agentSessionForNavigationKey,
  agentSessionNavigationIndex,
  agentSessionNavigationKey,
  isAgentTurnActive,
  pinnableAgentSessionItem,
  requiresUserAction,
  type AgentSession,
} from "@/features/agent-sessions";
import {
  continuesStayingNowRows,
  navigationKeyId,
  navigationRoutineId,
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
 * A row of Now: an active session that is not pinned, kept or not, and
 * whether the main area shows it; a kept object that is not an active
 * session, or a session that ended and is being kept in its place
 * (`ended`, DF-210 R1); or the temporary main area object.
 */
export type NowActiveRow = {
  kind: "active";
  session: AgentSession;
  kept: NavigationResolvedItem | null;
  main: boolean;
};

export type NowRow =
  | NowActiveRow
  | { kind: "kept"; item: NavigationResolvedItem; ended?: AgentSession }
  | { kind: "temporary"; temporary: NowTemporary };

export function isSessionKey(key: NavigationKey) {
  return key.kind === "session" || key.kind === "sessionLaunch";
}

export interface NowInput {
  pinned: readonly NavigationItem[];
  kept: readonly NavigationResolvedItem[];
  activeSessions: readonly AgentSession[];
  /** The listed sessions of the project, active or not. */
  sessions: readonly AgentSession[];
  /** The rows Now showed last, as its order recorded them. */
  shown: readonly NowOrderRow[];
  mainObject: MainAreaObject | null;
  described: NavigationResolvedItem | null;
}

/**
 * The rows of Now in the order new rows take (DF-206 R5): kept objects in
 * keep order, then sessions that ended while Now showed them, kept in their
 * place (DF-210 R1), then active sessions not kept, earlier activity first,
 * then the temporary main area object. An object is shown once in Pinned
 * and Now together. A Space main page is never temporary, and an artifact
 * is temporary only once its source confirmed it (`described`).
 */
export function composeNow({
  pinned,
  kept,
  activeSessions,
  sessions,
  shown,
  mainObject,
  described,
}: NowInput): NowRow[] {
  const active = activeSessions.filter(
    (session) => agentSessionNavigationIndex([...pinned], session) < 0,
  );
  const placed = new Set<AgentSession>();
  const main = (session: AgentSession) =>
    mainObject?.kind === "session" &&
    agentSessionForNavigationKey(mainObject.item.key, [session]) !== null;
  const rows = kept.flatMap((item): NowRow[] => {
    const session = isSessionKey(item.key)
      ? agentSessionForNavigationKey(item.key, active)
      : null;
    if (!session) return [{ kind: "kept", item }];
    if (placed.has(session)) return [];
    placed.add(session);
    return [{ kind: "active", session, kept: item, main: main(session) }];
  });
  const ended = endedNowSessions({
    pinned,
    kept,
    activeSessions,
    sessions,
    shown,
  });
  for (const session of ended) {
    const item = pinnableAgentSessionItem(session);
    if (item) rows.push({ kind: "kept", item, ended: session });
  }
  const newcomers = active
    .filter((session) => !placed.has(session))
    .sort((left, right) => activityMs(left) - activityMs(right));
  for (const session of newcomers) {
    rows.push({ kind: "active", session, kept: null, main: main(session) });
  }
  const temporary = temporaryOf(
    mainObject,
    pinned,
    kept,
    [...activeSessions, ...ended],
    described,
  );
  if (temporary) rows.push({ kind: "temporary", temporary });
  return rows;
}

/**
 * The sessions that ended since Now showed them as active sessions not
 * kept: no longer active, still listed and not pinned or kept. They stay
 * kept in their place (DF-210 R1). A hidden session was not shown, and a
 * session without identity has nothing to keep, so neither stays (R2).
 */
export function endedNowSessions({
  pinned,
  kept,
  activeSessions,
  sessions,
  shown,
}: Pick<
  NowInput,
  "pinned" | "kept" | "activeSessions" | "sessions" | "shown"
>): AgentSession[] {
  if (!shown.some((row) => row.stays)) return [];
  const listed = [...pinned, ...kept];
  const candidates = sessions.filter((session) => {
    const item = pinnableAgentSessionItem(session);
    return (
      item !== null &&
      agentSessionForNavigationKey(item.key, activeSessions) === null &&
      agentSessionNavigationIndex(listed, session) < 0
    );
  });
  const stays = continuesStayingNowRows(
    shown,
    candidates.map((session) => sessionOrderRow(session, null)),
  );
  return candidates.filter((_, index) => stays[index]);
}

/**
 * The key ids by which the Now order knows a row through its states. An
 * active session can be hidden until it starts a turn, waits for the user,
 * opens in the main area or is kept (DF-207 R2); one not kept stays kept in
 * its place once it ends (DF-210 R1). A row kept by a Routine launch is also
 * known by the Routine, so the next launch takes its place (R4).
 */
export function nowOrderRow(row: NowRow): NowOrderRow {
  switch (row.kind) {
    case "active":
      return {
        ...sessionOrderRow(row.session, row.kept),
        signs: [
          isAgentTurnActive(row.session),
          requiresUserAction(row.session),
          row.main,
          row.kept !== null,
        ],
        ...(row.kept === null ? { stays: true } : {}),
      };
    case "kept":
      return row.ended
        ? {
            ...sessionOrderRow(row.ended, null),
            stays: true,
            keep: { key: row.item.key, title: row.item.title },
          }
        : { ids: keptIds(row.item) };
    case "temporary": {
      const { item, session } = row.temporary;
      const order = session
        ? sessionOrderRow(session, null)
        : { ids: [navigationKeyId(item.key)] };
      return { ...order, temporary: true };
    }
  }
}

/** A kept row is one row by its key and the Routine that kept it. */
function keptIds(item: NavigationResolvedItem): string[] {
  const routine = navigationRoutineId(item);
  return [navigationKeyId(item.key), ...(routine ? [routine] : [])];
}

/**
 * A session row is one row by any of its ids and by the item it is kept by;
 * a pending session continues as the canonical one its terminal hands to.
 */
function sessionOrderRow(
  session: AgentSession,
  kept: NavigationResolvedItem | null,
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
  ];
  const ptyId = session.runtime?.ptyId;
  return {
    ids: [
      ...new Set([
        ...keys.map(navigationKeyId),
        ...(kept ? keptIds(kept) : []),
      ]),
    ],
    links: ptyId ? [JSON.stringify(["pty", ptyId])] : [],
  };
}

function activityMs(session: AgentSession): number {
  const time = Date.parse(session.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
}

/**
 * The temporary main area object; a session that Now shows in another row,
 * active or ended, is not one.
 */
function temporaryOf(
  object: MainAreaObject | null,
  pinned: readonly NavigationItem[],
  kept: readonly NavigationItem[],
  rowSessions: readonly AgentSession[],
  described: NavigationResolvedItem | null,
): NowTemporary | null {
  if (!object || object.kind === "space") return null;
  const listed = [...pinned, ...kept];
  if (object.kind === "session") {
    if (rowSessions.some((session) => session.id === object.session.id)) {
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

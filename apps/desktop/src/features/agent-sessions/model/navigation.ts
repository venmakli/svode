import type { NavigationItem, NavigationKey } from "@/features/navigation";
import type { AgentSessionsListResult } from "../api";
import { isPendingSessionId } from "./pending";
import type { AgentSession } from "./types";

/**
 * Navigation key of a session: its canonical id, or its launch id while the
 * catalog only knows a provisional launch.
 */
export function agentSessionNavigationKey(
  session: AgentSession,
): NavigationKey {
  return session.runtime?.provisional === true && session.launchId
    ? { kind: "sessionLaunch", launchId: session.launchId }
    : { kind: "session", sessionId: session.id };
}

export function agentSessionNavigationItem(
  session: AgentSession,
): NavigationItem {
  return { key: agentSessionNavigationKey(session), title: session.title };
}

/**
 * The navigation item a session is pinned by, or null while it has no
 * identity to pin: a pending session before the catalog matches it, or a
 * session of an unknown source.
 */
export function pinnableAgentSessionItem(
  session: AgentSession | null,
): NavigationItem | null {
  if (!session || session.source === "unknown") return null;
  if (isPendingSessionId(session.id)) return null;
  return agentSessionNavigationItem(session);
}

function addressesSession(key: NavigationKey, session: AgentSession) {
  if (key.kind === "session") return key.sessionId === session.id;
  if (key.kind === "sessionLaunch") return key.launchId === session.launchId;
  return false;
}

/**
 * The catalog session a navigation key addresses, or null while the catalog
 * does not list it. A launch key prefers the canonical session.
 */
export function agentSessionForNavigationKey(
  key: NavigationKey,
  sessions: readonly AgentSession[],
): AgentSession | null {
  const matches = sessions.filter((session) => addressesSession(key, session));
  return (
    matches.find((session) => session.runtime?.provisional !== true) ??
    matches[0] ??
    null
  );
}

/**
 * Position of the session among navigation items, or -1. A launch key keeps
 * addressing the canonical session that took over its launch id.
 */
export function agentSessionNavigationIndex(
  items: NavigationItem[],
  session: AgentSession,
): number {
  return items.findIndex((item) => addressesSession(item.key, session));
}

/**
 * Session keys whose absence the full list confirms: the list is a fresh
 * read and every source it would come from was read completely. A stale,
 * partial or failed read confirms nothing.
 */
export function confirmedMissingAgentSessionKeys(
  result: AgentSessionsListResult,
  keys: NavigationKey[],
): NavigationKey[] {
  if (result.status !== "ok" || result.cache.mode === "stale-snapshot") {
    return [];
  }
  const sourceRead = new Map<string, boolean>(
    result.sources.map((report) => [report.source, report.status === "ok"]),
  );
  const everySourceRead = result.sources.every(
    (report) => report.status === "ok",
  );
  return keys.filter((key) => {
    if (key.kind === "session") {
      const source = key.sessionId.slice(0, key.sessionId.indexOf(":"));
      return (
        sourceRead.get(source) === true &&
        !result.sessions.some((session) => session.id === key.sessionId)
      );
    }
    if (key.kind === "sessionLaunch") {
      return (
        everySourceRead &&
        !result.sessions.some((session) => session.launchId === key.launchId)
      );
    }
    return false;
  });
}

/**
 * Pinned or kept sessions whose listed title differs from their display
 * snapshot, with the snapshot to keep: the last known title shown while
 * unavailable.
 */
export function retitledAgentSessionItems(
  items: readonly NavigationItem[],
  sessions: readonly AgentSession[],
): NavigationItem[] {
  return items.flatMap((item) => {
    const session = agentSessionForNavigationKey(item.key, sessions);
    return session && session.title !== item.title
      ? [{ key: item.key, title: session.title }]
      : [];
  });
}

import type { NavigationItem, NavigationKey } from "@/features/navigation";
import type { AgentSessionsListResult } from "../api";
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

function addressesSession(key: NavigationKey, session: AgentSession) {
  if (key.kind === "session") return key.sessionId === session.id;
  if (key.kind === "sessionLaunch") return key.launchId === session.launchId;
  return false;
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

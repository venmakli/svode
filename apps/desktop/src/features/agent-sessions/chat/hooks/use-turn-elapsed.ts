import { useEffect, useState } from "react";
import type { AgentSessionKeyDto } from "../api/chat";

const TICK_MS = 1_000;

/**
 * When this window first saw each session's running turn. The snapshot
 * carries no start time; the chat that sends sees its turn at once, and
 * every surface of the session shares the same start.
 */
const starts = new Map<string, { turnId: string; at: number }>();

function startOf(session: AgentSessionKeyDto, turnId: string): number {
  const key = `${session.agent}\u0000${session.namespace}\u0000${session.sessionId}`;
  const known = starts.get(key);
  if (known?.turnId === turnId) return known.at;
  const at = Date.now();
  starts.set(key, { turnId, at });
  return at;
}

/** Milliseconds since the running turn started, ticking every second. */
export function useTurnElapsed(
  session: AgentSessionKeyDto,
  turnId: string,
): number {
  const [startedAt] = useState(() => startOf(session, turnId));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, now - startedAt);
}

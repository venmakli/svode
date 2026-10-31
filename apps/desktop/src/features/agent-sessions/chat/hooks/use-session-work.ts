import { useEffect } from "react";
import {
  holdSessionWork,
  publishSessionWork,
  sessionWorkFiles,
  useSessionWorkStore,
} from "../model/session-work";
import type { TimelineTurn } from "../model/timeline";

/**
 * Publishes the work of the session a chat shows for the "Changes" of its
 * window; nothing outlives the chat showing it.
 */
export function useSessionWorkPublisher(
  sessionId: string | null,
  turns: readonly TimelineTurn[],
) {
  const key = sessionWorkFiles(turns).join("\n");
  useEffect(() => {
    if (!sessionId) return;
    return holdSessionWork(sessionId);
  }, [sessionId]);
  useEffect(() => {
    if (sessionId) publishSessionWork(sessionId, key ? key.split("\n") : []);
  }, [sessionId, key]);
}

/** The work of a session while a chat shows it; null otherwise. */
export function useSessionWork(
  sessionId: string | null | undefined,
): readonly string[] | null {
  return useSessionWorkStore((state) =>
    sessionId ? (state.files[sessionId] ?? null) : null,
  );
}

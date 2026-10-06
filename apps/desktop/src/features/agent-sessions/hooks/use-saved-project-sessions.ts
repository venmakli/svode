import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listSavedAgentSessions } from "../api";
import { activeAgentSessions, type AgentSession } from "../model";

export interface SavedProjectSessions {
  /** The listed sessions; null until the first read answers. */
  sessions: AgentSession[] | null;
  /** The active sessions in their Now order. */
  active: AgentSession[];
  /** The last read failed; the previous list stays shown. */
  failed: boolean;
  /** Reads the list again. */
  refresh: () => void;
}

/**
 * The sessions of a project other than the open one, read apart from the
 * project catalog: no agent connection starts and the project is not
 * repaired or written. Read once when mounted and on every `refresh`.
 */
export function useSavedProjectSessions(
  projectPath: string,
): SavedProjectSessions {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(() => {
    const current = ++request.current;
    listSavedAgentSessions(projectPath).then(
      (result) => {
        if (current !== request.current) return;
        setSessions(result.sessions);
        setFailed(false);
      },
      (error: unknown) => {
        if (current !== request.current) return;
        console.warn("agent_sessions_list_saved failed:", error);
        setFailed(true);
      },
    );
  }, [projectPath]);

  useEffect(() => {
    refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  const active = useMemo(
    () => (sessions ? activeAgentSessions(sessions) : []),
    [sessions],
  );
  return { sessions, active, failed, refresh };
}

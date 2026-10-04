import { useCallback, useEffect, useState } from "react";
import { listChatAgents } from "../api/chat";
import type { ChatAgents } from "../model/agents";

/**
 * The agents a new session draft offers, read when the draft opens and on
 * demand; reading starts no agent process.
 */
export function useChatAgents() {
  const [agents, setAgents] = useState<ChatAgents | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    listChatAgents().then(
      (next) => {
        if (!current) return;
        setAgents(next);
        setFailed(false);
      },
      (error: unknown) => {
        console.error("Failed to read the chat agents:", error);
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { agents, failed, reload };
}

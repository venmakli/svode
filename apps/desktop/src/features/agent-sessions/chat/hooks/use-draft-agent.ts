import { useCallback, useEffect, useState } from "react";
import { holdDraftAgent, releaseDraftAgent, type AgentCheckDto } from "../api/chat";

export type DraftAgentState =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "checked"; check: AgentCheckDto }
  /** The draft could not ask the app at all. */
  | { state: "failed"; message: string };

/**
 * Choosing an agent in a new session draft is a lifecycle boundary: its
 * connection starts and stays while the draft keeps the agent, so the draft
 * shows the agent's readiness before the first prompt.
 */
export function useDraftAgent(agent: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    agent: string;
    attempt: number;
    value: DraftAgentState;
  } | null>(null);
  useEffect(() => {
    if (!agent) return;
    let current = true;
    let hold: number | null = null;
    holdDraftAgent(agent)
      .then((outcome) => {
        hold = outcome.hold;
        if (!current) {
          if (hold !== null) void releaseDraftAgent(hold).catch(() => {});
          return;
        }
        setResult({
          agent,
          attempt,
          value: { state: "checked", check: outcome.check },
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setResult({
          agent,
          attempt,
          value: {
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => {
      current = false;
      if (hold !== null) void releaseDraftAgent(hold).catch(() => {});
    };
  }, [agent, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const readiness: DraftAgentState = !agent
    ? { state: "idle" }
    : result && result.agent === agent && result.attempt === attempt
      ? result.value
      : { state: "connecting" };
  return { readiness, retry };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  holdDraftAgent,
  releaseDraftAgent,
  type AgentCheckDto,
  type AgentSessionKeyDto,
} from "../api/chat";

export type DraftAgentState =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "checked"; check: AgentCheckDto }
  /** The draft could not ask the app at all. */
  | { state: "failed"; message: string };

interface DraftHold {
  hold: number | null;
  /** The session the draft created without a prompt, if the agent allows it. */
  session: AgentSessionKeyDto | null;
}

const NO_HOLD: DraftHold = { hold: null, session: null };

/**
 * Choosing an agent in a new session draft is a lifecycle boundary: its
 * connection starts and stays while the draft keeps the agent and Space,
 * so the draft shows the agent's readiness before the first prompt. Where
 * the agent has evidence for it, the draft also gets its session, whose
 * settings and commands show before the first send.
 */
export function useDraftAgent(agent: string | null, cwd: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    value: DraftAgentState;
    hold: DraftHold;
  } | null>(null);
  const key = `${agent}\n${cwd}\n${attempt}`;
  useEffect(() => {
    if (!agent) return;
    let current = true;
    let hold: number | null = null;
    holdDraftAgent(agent, cwd)
      .then((outcome) => {
        hold = outcome.hold;
        if (!current) {
          if (hold !== null) void releaseDraftAgent(hold).catch(() => {});
          return;
        }
        setResult({
          key,
          value: { state: "checked", check: outcome.check },
          hold: { hold: outcome.hold, session: outcome.session },
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setResult({
          key,
          value: {
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
          hold: NO_HOLD,
        });
      });
    return () => {
      current = false;
      if (hold !== null) void releaseDraftAgent(hold).catch(() => {});
    };
  }, [agent, cwd, key]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const current = result && result.key === key ? result : null;
  const value = current?.value ?? null;
  const readiness = useMemo<DraftAgentState>(
    () => (!agent ? { state: "idle" } : (value ?? { state: "connecting" })),
    [agent, value],
  );
  const { hold, session } = current?.hold ?? NO_HOLD;
  return { readiness, retry, hold, session };
}

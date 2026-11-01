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
  /** The draft session takes the draft's values only with the first send. */
  keepsValuesUntilSend: boolean;
}

const NO_HOLD: DraftHold = {
  hold: null,
  session: null,
  keepsValuesUntilSend: false,
};

/**
 * Choosing an agent in a draft is a lifecycle boundary: its connection
 * starts and stays while the draft keeps the agent and Space, so the draft
 * shows the agent's readiness before the first prompt. Where the agent's
 * recorded evidence allows it, the draft also gets its session, whose
 * settings and commands show before the first send (Stage 11 `03`): the one
 * draft-session seam of a new session draft, an Actor binding and the
 * device's default agent.
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
          hold: {
            hold: outcome.hold,
            session: outcome.session,
            keepsValuesUntilSend: outcome.keepsValuesUntilSend,
          },
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
  const { hold, session, keepsValuesUntilSend } = current?.hold ?? NO_HOLD;
  return { readiness, retry, hold, session, keepsValuesUntilSend };
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentRuntimeErrorCode,
  answerAgentInteraction,
  cancelAgentTurn,
  promptAgentSession,
  type AgentInteractionAnswerDto,
  type AgentRuntimeErrorCode,
  type AgentSessionKeyDto,
  type AgentSessionSnapshotDto,
} from "../api/chat";
import { reconcileUnknownSend, sessionDraftKey } from "../model/composer";
import { useComposerDraft } from "./use-composer-draft";

/** How long an unknown send waits for the session to show a new turn. */
const RECONCILE_MS = 1500;

export interface SendRefusal {
  code: AgentRuntimeErrorCode | null;
  message: string;
}

/**
 * The composer of a session the runtime drives: sending and stopping
 * turns and answering the pending request (Stage 10 `04`, send and stop).
 * The draft stays until the runtime accepts the prompt; a send with an
 * unknown outcome is never repeated.
 */
export function useSessionComposer(
  sessionId: string,
  session: AgentSessionKeyDto,
  snapshot: AgentSessionSnapshotDto | null,
) {
  const [draft, updateDraft] = useComposerDraft(sessionDraftKey(sessionId));
  const [refusal, setRefusal] = useState<SendRefusal | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  });

  const sending = Boolean(draft.sending);
  const running = snapshot ? snapshot.turn.phase !== "none" : false;
  const cancelling = snapshot?.turn.phase === "cancelling";

  // An unknown send, also one interrupted by a reload, settles by the
  // session's own state: a new turn means the agent got the message.
  const previousTurnId = draft.sending?.previousTurnId;
  const settle = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    updateDraft((latest) => {
      if (!latest.sending) return latest;
      return reconcileUnknownSend(latest.sending.previousTurnId, current) ===
        "accepted"
        ? { text: "" }
        : { ...latest, sending: null, notSent: true };
    });
  }, [updateDraft]);
  useEffect(() => {
    if (previousTurnId === undefined || !snapshot) return;
    if (reconcileUnknownSend(previousTurnId, snapshot) === "accepted") {
      settle();
      return;
    }
    const timer = window.setTimeout(settle, RECONCILE_MS);
    return () => window.clearTimeout(timer);
  }, [previousTurnId, settle, snapshot]);

  const send = useCallback(async () => {
    const text = draft.text.trim();
    if (!text || sending || running) return;
    setRefusal(null);
    updateDraft({
      sending: { previousTurnId: snapshotRef.current?.turn.turnId ?? null },
      notSent: false,
    });
    try {
      await promptAgentSession(session, draft.text);
      updateDraft(() => ({ text: "" }));
    } catch (error) {
      const code = agentRuntimeErrorCode(error);
      if (code) {
        updateDraft({ sending: null });
        setRefusal({ code, message: errorMessage(error) });
      }
      // Neither a turn nor a refusal: the effect above settles it by the
      // session's state.
    }
  }, [draft.text, running, sending, session, updateDraft]);

  const stop = useCallback(() => {
    if (!running || cancelling) return;
    void cancelAgentTurn(session).catch((error: unknown) => {
      setRefusal({ code: agentRuntimeErrorCode(error), message: errorMessage(error) });
    });
  }, [cancelling, running, session]);

  const answer = useCallback(
    async (interaction: string, value: AgentInteractionAnswerDto) => {
      setAnswerError(null);
      try {
        // `not_pending` means the request was closed meanwhile; the
        // session's state shows its outcome.
        await answerAgentInteraction(session, interaction, value);
      } catch (error) {
        setAnswerError(errorMessage(error));
      }
    },
    [session],
  );

  return {
    draft,
    setText: (text: string) => updateDraft({ text, notSent: false }),
    sending,
    running,
    cancelling,
    refusal,
    answerError,
    send,
    stop,
    answer,
  };
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

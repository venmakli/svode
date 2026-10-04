import { useCallback, useEffect, useRef, useState } from "react";
import { signalSessionMessage } from "@/features/navigation";
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
import {
  isDraftBlank,
  promptParts,
  type DraftPart,
} from "../model/attachments";
import { reconcileUnknownSend, sessionDraftKey } from "../model/composer";
import { recheckAttachments } from "./use-attachment-preview";
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
  /**
   * Attaches a session the chat only read before its first send; false
   * when it did not attach, and the draft stays untouched.
   */
  attach?: () => Promise<boolean>,
) {
  const [draft, updateDraft] = useComposerDraft(sessionDraftKey(sessionId));
  const [refusal, setRefusal] = useState<SendRefusal | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  useEffect(() => {
    snapshotRef.current = snapshot;
  });
  // An accepted message keeps the session in Now (`01`, decision 16): once
  // per turn, whether the call returned it or the session showed it.
  const acceptedTurnRef = useRef<string | null>(null);
  const accept = useCallback(
    (turnId: string | null) => {
      if (!turnId || acceptedTurnRef.current === turnId) return;
      acceptedTurnRef.current = turnId;
      signalSessionMessage(sessionId);
    },
    [sessionId],
  );

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
        ? { parts: [] }
        : { ...latest, sending: null, notSent: true };
    });
  }, [updateDraft]);
  useEffect(() => {
    if (previousTurnId === undefined || !snapshot) return;
    if (reconcileUnknownSend(previousTurnId, snapshot) === "accepted") {
      accept(snapshot.turn.turnId);
      settle();
      return;
    }
    const timer = window.setTimeout(settle, RECONCILE_MS);
    return () => window.clearTimeout(timer);
  }, [accept, previousTurnId, settle, snapshot]);

  const send = useCallback(async () => {
    if (isDraftBlank(draft.parts) || sending || running) return;
    setRefusal(null);
    if (snapshotRef.current?.writer !== "acp" && attach && !(await attach())) {
      return;
    }
    updateDraft({
      sending: { previousTurnId: snapshotRef.current?.turn.turnId ?? null },
      notSent: false,
    });
    try {
      accept(await promptAgentSession(session, promptParts(draft.parts)));
      updateDraft(() => ({ parts: [] }));
    } catch (error) {
      const code = agentRuntimeErrorCode(error);
      if (code) {
        updateDraft({ sending: null });
        setRefusal({ code, message: errorMessage(error) });
        if (code === "file_unavailable") recheckAttachments();
      }
      // Neither a turn nor a refusal: the effect above settles it by the
      // session's state.
    }
  }, [accept, attach, draft.parts, running, sending, session, updateDraft]);

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
    setParts: (parts: DraftPart[]) => updateDraft({ parts, notSent: false }),
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

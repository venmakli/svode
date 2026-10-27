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
  type AgentSettingValueDto,
} from "../api/chat";
import {
  isDraftBlank,
  promptParts,
  type DraftPart,
} from "../model/attachments";
import {
  draftValues,
  reconcileUnknownSend,
  sessionDraftKey,
} from "../model/composer";
import { attachPlan, withDraftValue } from "../model/session-controls";
import { recheckAttachments } from "./use-attachment-preview";
import { useComposerDraft } from "./use-composer-draft";
import type { AttachOutcome } from "./use-session-opening";

const NO_VALUES: AgentSettingValueDto[] = [];

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
 * unknown outcome is never repeated. Before the chat attaches a session it
 * read, the draft keeps the setting values chosen for it, and the first
 * send attaches the session with them (DF-171 R1, R3).
 */
export function useSessionComposer(
  sessionId: string,
  session: AgentSessionKeyDto,
  snapshot: AgentSessionSnapshotDto | null,
  /**
   * Attaches a session the chat only read for its first send, with the
   * chosen values, `confirmed` while a turn is open; when it did not
   * attach, the draft stays.
   */
  attach?: (
    settings: AgentSettingValueDto[],
    confirmed: boolean,
  ) => Promise<AttachOutcome>,
  /** What the session's own last turn gives attaching it (DF-171 R2). */
  sessionValues: AgentSettingValueDto[] = NO_VALUES,
) {
  const draftKey = sessionDraftKey(sessionId);
  const [draft, updateDraft] = useComposerDraft(draftKey);
  const agent = session.agent;
  const chosen = draftValues(draft, agent);
  const plan = attachPlan(sessionValues, chosen);
  // Once the runtime drives the session its own values show; the chosen
  // ones were applied or are no longer meant for an attach.
  const attached = snapshot?.writer === "acp";
  const planned = chosen.length > 0;
  useEffect(() => {
    if (attached && planned) updateDraft({ settings: null });
  }, [attached, planned, updateDraft]);
  const choose = useCallback(
    (value: AgentSettingValueDto) =>
      updateDraft((latest) => ({
        ...latest,
        settings: {
          agent,
          values: withDraftValue(draftValues(latest, agent), value),
        },
      })),
    [agent, updateDraft],
  );
  const [refusal, setRefusal] = useState<SendRefusal | null>(null);
  // The send waits for the user's confirmation of attaching the session
  // while a turn is open (DF-231 R2).
  const [confirmationAsked, setConfirmation] = useState(false);
  const confirmation = confirmationAsked && !attached;
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

  const send = useCallback(async (confirmed = false) => {
    if (isDraftBlank(draft.parts) || sending || running) return;
    // Only the confirmation's own button sends, never a repeated Enter.
    if (confirmation && !confirmed) return;
    setRefusal(null);
    if (snapshotRef.current?.writer !== "acp" && attach) {
      setConfirmation(false);
      const outcome = await attach(plan, confirmed);
      if (!outcome.attached) {
        if (outcome.confirm) setConfirmation(true);
        // A refused value goes back to what the session has; nothing was sent.
        const refused = outcome.refusedSetting;
        if (refused) {
          updateDraft((latest) => ({
            ...latest,
            settings: {
              agent,
              values: draftValues(latest, agent).filter(
                (value) =>
                  value.setting !== refused.setting || value.value !== refused.value,
              ),
            },
          }));
        }
        return;
      }
    }
    updateDraft({
      sending: { previousTurnId: snapshotRef.current?.turn.turnId ?? null },
      notSent: false,
    });
    try {
      accept(await promptAgentSession(session, promptParts(draft.parts)));
      // The session may have shown the turn first and settled the send;
      // what was typed since stays.
      updateDraft((latest) => (latest.sending ? { parts: [] } : latest));
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
  }, [
    accept,
    agent,
    attach,
    confirmation,
    draft.parts,
    plan,
    running,
    sending,
    session,
    updateDraft,
  ]);

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
    draftKey,
    draft,
    setParts: (parts: DraftPart[]) => updateDraft({ parts, notSent: false }),
    /**
     * Values attaching the session applies: the session's own, replaced by
     * those chosen before it is attached.
     */
    plan,
    choose,
    sending,
    running,
    cancelling,
    refusal,
    answerError,
    send: () => send(),
    /** A turn is open: sending waits for the user's confirmation. */
    confirmation,
    /** Attaches the session as the user confirmed and sends once. */
    confirmSend: () => send(true),
    /** The draft stays unsent. */
    cancelConfirmation: () => setConfirmation(false),
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

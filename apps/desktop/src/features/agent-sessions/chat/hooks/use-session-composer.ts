import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  agentRuntimeErrorCode,
  answerAgentInteraction,
  cancelAgentTurn,
  type AgentInteractionAnswerDto,
  type AgentSessionKeyDto,
  type AgentSessionSnapshotDto,
  type AgentSettingValueDto,
} from "../api/chat";
import type { SessionActivity } from "../api/session-activity";
import type { DraftPart } from "../model/attachments";
import { draftValues, sessionDraftKey } from "../model/composer";
import { attachPlan, withDraftValue } from "../model/session-controls";
import {
  cancelSendConfirmation,
  errorMessage,
  registerSessionSendTarget,
  resumeSessionSend,
  sendSessionDraft,
  sessionSendState,
  subscribeSessionSend,
  type SendRefusal,
} from "./session-send";
import { useComposerDraft } from "./use-composer-draft";
import type { AttachOutcome } from "./use-session-opening";

const NO_VALUES: AgentSettingValueDto[] = [];

export function useSessionComposer(
  sessionId: string,
  session: AgentSessionKeyDto,
  snapshot: AgentSessionSnapshotDto | null,
  activity: SessionActivity | null,
  attach?: (settings: AgentSettingValueDto[], confirmed: boolean) => Promise<AttachOutcome>,
  sessionValues: AgentSettingValueDto[] = NO_VALUES,
) {
  const draftKey = sessionDraftKey(sessionId);
  const [draft, updateDraft] = useComposerDraft(draftKey);
  const subscribe = useCallback((listener: () => void) =>
    subscribeSessionSend(draftKey, listener), [draftKey]);
  const sendState = useSyncExternalStore(subscribe, () => sessionSendState(draftKey));
  const target = useMemo(
    () => ({ draftKey, sessionId, session, activity, attach, sessionValues }),
    [activity, attach, draftKey, session, sessionId, sessionValues],
  );
  useLayoutEffect(() => registerSessionSendTarget(target), [target]);

  // Reloaded drafts follow the runtime to settle the old prompt. An attempt
  // already owned by this document keeps following it when a chat remounts.
  useEffect(() => {
    if (snapshot && draft.sending) resumeSessionSend(target);
  }, [draft.sending, snapshot, target]);

  const agent = session.agent;
  const chosen = draftValues(draft, agent);
  const plan = attachPlan(sessionValues, chosen);
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
  const [stopRefusal, setStopRefusal] = useState<SendRefusal | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const running = snapshot ? snapshot.turn.phase !== "none" : false;
  const cancelling = snapshot?.turn.phase === "cancelling";

  const stop = useCallback(() => {
    if (!running || cancelling) return;
    void cancelAgentTurn(session).catch((error: unknown) => {
      setStopRefusal({ code: agentRuntimeErrorCode(error), message: errorMessage(error) });
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
    plan,
    choose,
    sending: sendState.busy || Boolean(draft.sending),
    running,
    cancelling,
    refusal: sendState.refusal ?? stopRefusal,
    answerError,
    send: () => {
      setStopRefusal(null);
      return sendSessionDraft(target);
    },
    sendDictated: () => void sendSessionDraft(target, { dictated: true }),
    confirmation: sendState.confirmation && !attached,
    confirmSend: () => sendSessionDraft(target, { confirmed: true }),
    cancelConfirmation: () => cancelSendConfirmation(draftKey),
    stop,
    answer,
  };
}

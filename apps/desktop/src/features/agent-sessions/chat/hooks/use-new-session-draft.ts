import { useCallback, useEffect, useState } from "react";
import { signalSessionMessage } from "@/features/navigation";
import {
  agentRuntimeErrorCode,
  agentSettingRefusal,
  startAgentSession,
  type AgentLaunchUnavailableDto,
  type AgentSessionKeyDto,
} from "../api/chat";
import { defaultAgentValues, draftAgent } from "../model/agents";
import type { SettingValue } from "../model/session-controls";
import {
  isDraftBlank,
  promptParts,
  type DraftPart,
} from "../model/attachments";
import {
  newSessionDraftKey,
  sessionDraftKey,
  type ComposerDraft,
} from "../model/composer";
import { recheckAttachments } from "./use-attachment-preview";
import { useChatAgents } from "./use-chat-agents";
import { useChosenAgentSettings } from "./use-chosen-agent-settings";
import { useComposerDraft } from "./use-composer-draft";
import { passComposerFocus } from "./use-composer-focus";
import { useDefaultAgent } from "./use-default-agent";
import type { UpdateKeptValues } from "./use-draft-settings";
import { errorMessage, type SendRefusal } from "./use-session-composer";

export interface StartedSession {
  sessionId: string;
  session: AgentSessionKeyDto;
}

export type DraftRefusal =
  | ({ kind: "runtime" } & SendRefusal)
  | { kind: "unavailable"; reason: AgentLaunchUnavailableDto };

/**
 * A new session draft (Stage 10 `04`, new session): the chosen agent and
 * Space, the setting values and the text, kept for the window. It starts
 * with the device's default agent and its values, the mode included, and
 * a change in the draft stays in the draft (Stage 11 `03`). The draft
 * shows no session; where the agent has evidence for it, the draft's
 * session exists without a prompt, so its settings and commands show and
 * change before the first send. A draft session that takes values only
 * with the first send, or the agent's last declarations without a draft
 * session, show the settings while the draft keeps the chosen values. The
 * first send creates the session, or sends the prompt to the draft's one,
 * which then enters the catalogue.
 */
export function useNewSessionDraft(
  initialSpacePath: string,
  onStarted: (started: StartedSession) => void,
) {
  const draftKey = newSessionDraftKey(initialSpacePath);
  const [draft, updateDraft] = useComposerDraft(draftKey);
  const { agents, failed: agentsFailed, reload } = useChatAgents();
  const defaultAgent = useDefaultAgent();
  // No agent starts before the draft knows which one it begins with.
  const agent =
    agents && defaultAgent.loaded
      ? draftAgent(agents, draft.agent, defaultAgent.value?.agent ?? null)
      : null;
  const spacePath = draft.spacePath ?? initialSpacePath;
  // Until the draft keeps values of its own it has the default agent's.
  const valuesOf = useCallback(
    (latest: ComposerDraft): SettingValue[] =>
      latest.settings?.agent === agent
        ? latest.settings.values
        : defaultAgentValues(
            latest.settings ? null : defaultAgent.value,
            agent,
          ),
    [agent, defaultAgent.value],
  );
  const values = valuesOf(draft);
  const updateValues = useCallback<UpdateKeptValues>(
    (change) => {
      if (!agent) return;
      updateDraft((latest) => ({
        ...latest,
        settings: { agent, values: change(valuesOf(latest)) },
      }));
    },
    [agent, updateDraft, valuesOf],
  );
  const chosen = useChosenAgentSettings({
    agent,
    cwd: spacePath,
    offer:
      agents?.agents.find((candidate) => candidate.agent === agent)?.offer ??
      null,
    values,
    updateValues,
  });
  const { readiness, hold, snapshot } = chosen;
  const [refusal, setRefusal] = useState<DraftRefusal | null>(null);
  const ready =
    readiness.state === "checked" && readiness.check.state === "ready";

  // Nothing tells whether a send cut by a reload reached the agent: the
  // text comes back marked, and the user decides.
  const interrupted = Boolean(draft.sending);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (interrupted && !sending) {
      updateDraft({ sending: null, notSent: true });
    }
  }, [interrupted, sending, updateDraft]);

  const send = useCallback(async () => {
    if (isDraftBlank(draft.parts) || !agent || sending || chosen.changing) {
      return;
    }
    if (!ready) return;
    setRefusal(null);
    chosen.dismissRefusal();
    setSending(true);
    updateDraft({ sending: { previousTurnId: null }, notSent: false });
    try {
      const started = await startAgentSession({
        agent,
        cwd: spacePath,
        settings: values,
        prompt: promptParts(draft.parts),
        hold,
        // A request a Svode action put in carries its mark (Stage 11 1.E).
        mark: draft.mark,
      });
      if (started.outcome === "started") {
        updateDraft(() => ({ parts: [] }));
        // The first send keeps the new session in Now (`01`, decision 16).
        signalSessionMessage(started.sessionId);
        passComposerFocus(draftKey, sessionDraftKey(started.sessionId));
        onStarted({ sessionId: started.sessionId, session: started.session });
        return;
      }
      updateDraft({ sending: null });
      setRefusal({ kind: "unavailable", reason: started.reason });
      reload();
    } catch (error) {
      const code = agentRuntimeErrorCode(error);
      updateDraft(code ? { sending: null } : { sending: null, notSent: true });
      // A value the new session does not offer keeps the draft with its
      // reason; nothing was sent.
      const setting = agentSettingRefusal(error);
      if (setting) {
        chosen.refuse(setting);
      } else {
        setRefusal({ kind: "runtime", code, message: errorMessage(error) });
        if (code === "file_unavailable") recheckAttachments();
      }
    } finally {
      setSending(false);
    }
  }, [
    agent,
    chosen,
    draft,
    draftKey,
    hold,
    onStarted,
    ready,
    reload,
    sending,
    spacePath,
    updateDraft,
    values,
  ]);

  return {
    draftKey,
    draft,
    setParts: (parts: DraftPart[]) => updateDraft({ parts, notSent: false }),
    agents,
    agentsFailed,
    reloadAgents: reload,
    agent,
    chooseAgent: (next: string) => {
      setRefusal(null);
      chosen.dismissRefusal();
      updateDraft({ agent: next });
    },
    readiness,
    retryAgent: chosen.retry,
    /** After sign-in: read the agents' sign-in again and start the agent anew. */
    recheckAgent: () => {
      reload();
      chosen.retry();
    },
    spacePath,
    chooseSpace: (path: string) => updateDraft({ spacePath: path }),
    /** The draft session's settings, commands and usage once it exists. */
    snapshot,
    /** The settings the draft shows, with the values it keeps. */
    settings: chosen.settings,
    /** The draft keeps the chosen values until the first send. */
    keepsValues: chosen.keepsValues,
    /** The settings come from the agent's last session on this device. */
    recordedSettings: chosen.recorded,
    /** Settings whose options show after a session with the chosen model. */
    settingsWithoutVariants: chosen.withoutVariants,
    /** Nothing declared yet: the agent's settings show after the first send. */
    settingsAfterSend: chosen.settingsAfterSend,
    changeSetting: chosen.changeSetting,
    changingSetting: chosen.changing,
    settingRefusal: chosen.refusal,
    sending,
    refusal,
    send,
  };
}

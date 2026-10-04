import { useCallback, useEffect, useMemo, useState } from "react";
import { signalSessionMessage } from "@/features/navigation";
import {
  agentRuntimeErrorCode,
  agentSettingRefusal,
  startAgentSession,
  type AgentLaunchUnavailableDto,
  type AgentSessionKeyDto,
} from "../api/chat";
import { draftAgent } from "../model/agents";
import {
  isDraftBlank,
  promptParts,
  type DraftPart,
} from "../model/attachments";
import { newSessionDraftKey } from "../model/composer";
import { recheckAttachments } from "./use-attachment-preview";
import { useChatAgents } from "./use-chat-agents";
import { useComposerDraft } from "./use-composer-draft";
import { useDraftAgent, type DraftAgentState } from "./use-draft-agent";
import { draftValues, useDraftSettings } from "./use-draft-settings";
import { useSessionActivity } from "./use-session-activity";
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
 * Space, the setting values and the text, kept for the window. The draft
 * shows no session; where the agent has evidence for it, the draft's
 * session exists without a prompt, so its settings and commands show and
 * change before the first send. The first send creates the session, or
 * sends the prompt to the draft's one, which then enters the catalogue.
 */
export function useNewSessionDraft(
  initialSpacePath: string,
  onStarted: (started: StartedSession) => void,
) {
  const [draft, updateDraft] = useComposerDraft(
    newSessionDraftKey(initialSpacePath),
  );
  const { agents, failed: agentsFailed, reload } = useChatAgents();
  const agent = agents ? draftAgent(agents, draft.agent) : null;
  const spacePath = draft.spacePath ?? initialSpacePath;
  const {
    readiness: started,
    retry,
    hold,
    session: draftSession,
  } = useDraftAgent(agent, spacePath);
  const { snapshot } = useSessionActivity(draftSession);
  const settings = useDraftSettings(agent, draftSession, snapshot, draft, updateDraft);
  // The agent's ACP connection starts without sign-in; its own sign-in
  // check tells that the first send would be refused.
  const signInRequired =
    agents?.agents.find((candidate) => candidate.agent === agent)?.offer
      .state === "sign_in_required";
  const readiness = useMemo<DraftAgentState>(
    () =>
      signInRequired &&
      started.state === "checked" &&
      started.check.state === "ready"
        ? { state: "checked", check: { state: "auth_required", message: "" } }
        : started,
    [signInRequired, started],
  );
  const [refusal, setRefusal] = useState<DraftRefusal | null>(null);
  const ready = readiness.state === "checked" && readiness.check.state === "ready";

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
    if (isDraftBlank(draft.parts) || !agent || sending || settings.changing) {
      return;
    }
    if (!ready) return;
    setRefusal(null);
    settings.dismissRefusal();
    setSending(true);
    updateDraft({ sending: { previousTurnId: null }, notSent: false });
    try {
      const started = await startAgentSession({
        agent,
        cwd: spacePath,
        settings: draftValues(draft, agent),
        prompt: promptParts(draft.parts),
        hold,
      });
      if (started.outcome === "started") {
        updateDraft(() => ({ parts: [] }));
        // The first send keeps the new session in Now (`01`, decision 16).
        signalSessionMessage(started.sessionId);
        onStarted({ sessionId: started.sessionId, session: started.session });
        return;
      }
      updateDraft({ sending: null });
      setRefusal({ kind: "unavailable", reason: started.reason });
      reload();
    } catch (error) {
      const code = agentRuntimeErrorCode(error);
      updateDraft(
        code ? { sending: null } : { sending: null, notSent: true },
      );
      // A value the new session does not offer keeps the draft with its
      // reason; nothing was sent.
      const setting = agentSettingRefusal(error);
      if (setting) {
        settings.refuse(setting);
      } else {
        setRefusal({ kind: "runtime", code, message: errorMessage(error) });
        if (code === "file_unavailable") recheckAttachments();
      }
    } finally {
      setSending(false);
    }
  }, [
    agent,
    draft,
    hold,
    onStarted,
    ready,
    reload,
    sending,
    settings,
    spacePath,
    updateDraft,
  ]);

  return {
    draft,
    setParts: (parts: DraftPart[]) => updateDraft({ parts, notSent: false }),
    agents,
    agentsFailed,
    reloadAgents: reload,
    agent,
    chooseAgent: (next: string) => {
      setRefusal(null);
      settings.dismissRefusal();
      updateDraft({ agent: next });
    },
    readiness,
    retryAgent: retry,
    /** After sign-in: read the agents' sign-in again and start the agent anew. */
    recheckAgent: () => {
      reload();
      retry();
    },
    spacePath,
    chooseSpace: (path: string) => updateDraft({ spacePath: path }),
    /** The draft session's settings, commands and usage once it exists. */
    snapshot: draftSession ? snapshot : null,
    /** No draft session: the agent's settings show after the first send. */
    settingsAfterSend: ready && !draftSession,
    changeSetting: settings.changeSetting,
    changingSetting: settings.changing,
    settingRefusal: settings.refusal,
    sending,
    refusal,
    send,
  };
}

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
import { declaredSettings, withKeptValue } from "../model/declared-settings";
import type { SettingValue } from "../model/session-controls";
import {
  isDraftBlank,
  promptParts,
  type DraftPart,
} from "../model/attachments";
import {
  draftValues,
  newSessionDraftKey,
  sessionDraftKey,
} from "../model/composer";
import { useLastAgentDeclarations } from "./use-agent-declarations";
import { recheckAttachments } from "./use-attachment-preview";
import { useChatAgents } from "./use-chat-agents";
import { useComposerDraft } from "./use-composer-draft";
import { passComposerFocus } from "./use-composer-focus";
import { useDraftAgent, type DraftAgentState } from "./use-draft-agent";
import { useDraftSettings } from "./use-draft-settings";
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
 * change before the first send. A draft session that takes values only
 * with the first send, or the agent's last declarations without a draft
 * session, show the settings while the draft keeps the chosen values
 * (Stage 11 `03`). The first send creates the session, or sends the prompt
 * to the draft's one, which then enters the catalogue.
 */
export function useNewSessionDraft(
  initialSpacePath: string,
  onStarted: (started: StartedSession) => void,
) {
  const draftKey = newSessionDraftKey(initialSpacePath);
  const [draft, updateDraft] = useComposerDraft(draftKey);
  const { agents, failed: agentsFailed, reload } = useChatAgents();
  const agent = agents ? draftAgent(agents, draft.agent) : null;
  const spacePath = draft.spacePath ?? initialSpacePath;
  const {
    readiness: started,
    retry,
    hold,
    session: draftSession,
    keepsValuesUntilSend,
  } = useDraftAgent(agent, spacePath);
  const { snapshot } = useSessionActivity(draftSession);
  // Values change in the draft session itself only where it takes them.
  const liveSession = keepsValuesUntilSend ? null : draftSession;
  const settings = useDraftSettings(
    agent,
    liveSession,
    snapshot,
    draft,
    updateDraft,
  );
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
  const ready =
    readiness.state === "checked" && readiness.check.state === "ready";
  // Without a live draft session the draft keeps the chosen values itself.
  const keepsValues = ready && !liveSession;
  const declarations = useLastAgentDeclarations(agent, keepsValues);
  const declared = useMemo(() => {
    if (!keepsValues) return null;
    // A draft session's own declaration comes first once it arrives.
    if (draftSession && !snapshot) {
      return { settings: null, recorded: false, withoutVariants: [] };
    }
    return declaredSettings({
      session: snapshot?.settings ?? null,
      declarations: declarations ?? [],
      values: draftValues(draft, agent),
    });
  }, [agent, declarations, draft, draftSession, keepsValues, snapshot]);
  const shownSettings = declared
    ? declared.settings
    : liveSession && snapshot
      ? snapshot.settings
      : null;
  const keepValue = useCallback(
    (value: SettingValue) => {
      if (!agent) return;
      updateDraft((latest) => ({
        ...latest,
        settings: {
          agent,
          values: withKeptValue(
            draftValues(latest, agent),
            value,
            shownSettings ?? [],
          ),
        },
      }));
    },
    [agent, shownSettings, updateDraft],
  );

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
    draftKey,
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
    draftKey,
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
    /** The settings the draft shows, with the values it keeps. */
    settings: shownSettings,
    /** The draft keeps the chosen values until the first send. */
    keepsValues,
    /** The settings come from the agent's last session on this device. */
    recordedSettings: declared?.recorded ?? false,
    /** Settings whose options show after a session with the chosen model. */
    settingsWithoutVariants: declared?.withoutVariants ?? [],
    /** Nothing declared yet: the agent's settings show after the first send. */
    settingsAfterSend:
      keepsValues &&
      !draftSession &&
      declarations !== null &&
      shownSettings === null,
    changeSetting: keepsValues
      ? async (value: SettingValue) => keepValue(value)
      : settings.changeSetting,
    changingSetting: settings.changing,
    settingRefusal: settings.refusal,
    sending,
    refusal,
    send,
  };
}

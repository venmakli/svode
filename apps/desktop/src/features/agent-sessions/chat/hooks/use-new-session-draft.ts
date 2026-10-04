import { useCallback, useEffect, useState } from "react";
import {
  agentRuntimeErrorCode,
  startAgentSession,
  type AgentLaunchUnavailableDto,
  type AgentSessionKeyDto,
} from "../api/chat";
import { draftAgent } from "../model/agents";
import { newSessionDraftKey } from "../model/composer";
import { useChatAgents } from "./use-chat-agents";
import { useComposerDraft } from "./use-composer-draft";
import { useDraftAgent } from "./use-draft-agent";
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
 * Space and the text, kept for the window. The draft creates nothing; the
 * first send creates the session and sends its prompt.
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
  const { readiness, retry } = useDraftAgent(agent);
  const [refusal, setRefusal] = useState<DraftRefusal | null>(null);
  const spacePath = draft.spacePath ?? initialSpacePath;

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
    const text = draft.text.trim();
    if (!text || !agent || sending) return;
    if (readiness.state !== "checked" || readiness.check.state !== "ready") {
      return;
    }
    setRefusal(null);
    setSending(true);
    updateDraft({ sending: { previousTurnId: null }, notSent: false });
    try {
      const started = await startAgentSession({
        agent,
        cwd: spacePath,
        settings: [],
        text: draft.text,
      });
      if (started.outcome === "started") {
        updateDraft(() => ({ text: "" }));
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
      setRefusal({ kind: "runtime", code, message: errorMessage(error) });
    } finally {
      setSending(false);
    }
  }, [agent, draft.text, onStarted, readiness, reload, sending, spacePath, updateDraft]);

  return {
    draft,
    setText: (text: string) => updateDraft({ text, notSent: false }),
    agents,
    agentsFailed,
    reloadAgents: reload,
    agent,
    chooseAgent: (next: string) => {
      setRefusal(null);
      updateDraft({ agent: next });
    },
    readiness,
    retryAgent: retry,
    spacePath,
    chooseSpace: (path: string) => updateDraft({ spacePath: path }),
    sending,
    refusal,
    send,
  };
}

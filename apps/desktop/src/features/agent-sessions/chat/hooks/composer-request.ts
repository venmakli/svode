import type { AgentTurnMarkDto } from "@/platform/agent-runtime/agent-runtime-api";
import { listChatAgents } from "../api/chat";
import { canOpenChatDraft } from "../model/agents";
import {
  appendComposerDraftRequest,
  newSessionDraftKey,
  sessionDraftKey,
} from "../model/composer";
import { requestDraftComposerFocus } from "./use-composer-focus";

// A request a Svode action composed for an agent, such as «Зафиксировать с
// агентом» (Stage 11 1.10), goes into a composer draft marked with `mark`
// and the composer takes focus; the user edits and sends it.

/** Puts a request after the typed text of session `sessionId`'s composer. */
export function putSessionRequest(
  sessionId: string,
  text: string,
  mark: AgentTurnMarkDto,
) {
  const key = sessionDraftKey(sessionId);
  appendComposerDraftRequest(key, text, mark);
  requestDraftComposerFocus(key);
}

/**
 * Puts a request into the new session draft of `spacePath`; its composer
 * takes focus once the draft is shown.
 */
export function putNewSessionRequest(
  spacePath: string,
  text: string,
  mark: AgentTurnMarkDto,
) {
  const key = newSessionDraftKey(spacePath);
  appendComposerDraftRequest(key, text, mark);
  requestDraftComposerFocus(key);
}

/** Some agent can chat now, so a new chat session draft can open. */
export async function canOpenChatSession(): Promise<boolean> {
  const agents = await listChatAgents().catch((error: unknown) => {
    console.error("Failed to read the chat agents:", error);
    return null;
  });
  return agents ? canOpenChatDraft(agents) : false;
}

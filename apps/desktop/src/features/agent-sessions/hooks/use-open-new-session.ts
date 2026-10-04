import { useCallback } from "react";
import { listChatAgents } from "../chat/api/chat";
import { canOpenChatDraft } from "../chat/model/agents";
import type { AgentSessionTarget, NewSessionDraftTarget } from "../model";
import { useStartAgentSession } from "./use-start-agent-session";

export type NewSessionOpening =
  | { kind: "draft"; draft: NewSessionDraftTarget }
  | { kind: "terminal"; target: AgentSessionTarget };

/**
 * "New session" (Stage 10 `04`, chat and terminal): a chat draft when some
 * agent can chat now, otherwise the managed terminal of phase 1. Resolves
 * to what opened, or null when nothing could.
 */
export function useOpenNewSession() {
  const startTerminal = useStartAgentSession();
  return useCallback(
    async (spacePath: string): Promise<NewSessionOpening | null> => {
      const agents = await listChatAgents().catch((error: unknown) => {
        console.error("Failed to read the chat agents:", error);
        return null;
      });
      if (agents && canOpenChatDraft(agents)) {
        return {
          kind: "draft",
          draft: { draftId: crypto.randomUUID(), spacePath },
        };
      }
      const target = await startTerminal(spacePath);
      return target ? { kind: "terminal", target } : null;
    },
    [startTerminal],
  );
}

import { useCallback } from "react";
import { toast } from "sonner";
import { getNativeErrorMessage } from "@/platform/native/errors";
import type { AgentSessionTarget } from "../model";
import { useAgentSessionCatalog } from "./use-agent-session-catalog";
import { useAgentSessionScopes } from "./use-agent-session-scopes";
import * as m from "@/paraglide/messages.js";

/**
 * Starts a new session in a registered Space: a managed terminal that the
 * catalog lists as a pending session until the CLI session is matched to it.
 * Resolves to its target, or null when the Space is not ready or it failed.
 */
export function useStartAgentSession() {
  const scopes = useAgentSessionScopes();
  const openNewSessionTerminal = useAgentSessionCatalog(
    (state) => state.openNewSessionTerminal,
  );
  return useCallback(
    async (spacePath: string): Promise<AgentSessionTarget | null> => {
      const scope = scopes.find((candidate) => candidate.path === spacePath);
      if (!scope || scope.status !== "ready") return null;
      try {
        const sessionId = await openNewSessionTerminal(
          scope,
          m.sessions_new_title(),
        );
        return sessionId ? { sessionId, launchId: null } : null;
      } catch (error) {
        toast.error(m.sessions_toast_open_terminal_failed(), {
          description: getNativeErrorMessage(error),
        });
        return null;
      }
    },
    [openNewSessionTerminal, scopes],
  );
}

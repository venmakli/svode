import { useEffect } from "react";
import {
  canOpenChatSession,
  putNewSessionRequest,
  putSessionRequest,
} from "@/features/agent-sessions";
import { registerAgentRequests } from "@/features/git/app-shell";
import { getSpaceSnapshot } from "@/features/space";
import { useStartRequestInMainArea } from "./agent-session-peek-host";

/**
 * Takes requests for agents that commit themselves (Stage 11 1.10, 1.12)
 * into chat sessions: in the window of a chat session into its composer,
 * otherwise into a new chat session of the Space's default agent in the
 * main area, as "New session" opens it. Nothing is sent.
 */
export function AgentRequestsHost() {
  const startRequest = useStartRequestInMainArea();
  useEffect(
    () =>
      registerAgentRequests({
        available: async ({ spacePath, sessionId }) =>
          Boolean(sessionId) ||
          (spaceTakesSession(spacePath) && (await canOpenChatSession())),
        submit: async ({ spacePath, sessionId, text, mark }) => {
          if (sessionId) {
            putSessionRequest(sessionId, text, mark);
            return true;
          }
          if (!spaceTakesSession(spacePath) || !(await canOpenChatSession())) {
            return false;
          }
          return startRequest(spacePath, () =>
            putNewSessionRequest(spacePath, text, mark),
          );
        },
      }),
    [startRequest],
  );
  return null;
}

/** The project root or a ready Space of it, where a new session can start. */
function spaceTakesSession(spacePath: string): boolean {
  const { activeRootPath, spaces } = getSpaceSnapshot();
  return (
    spacePath === activeRootPath ||
    spaces.some((space) => space.path === spacePath && space.status === "ready")
  );
}

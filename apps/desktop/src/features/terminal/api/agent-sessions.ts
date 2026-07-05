import {
  listAgentSessions,
  refreshAgentSessions,
} from "@/platform/agent-sessions/agent-sessions-api";
import type {
  AgentSession,
  AgentSessionsListResult,
  AgentSessionSource,
} from "@/platform/agent-sessions/agent-sessions-api";

export type { AgentSession, AgentSessionsListResult, AgentSessionSource };

export function listTerminalAgentSessions(
  projectPath: string,
  forceRefresh = false,
): Promise<AgentSessionsListResult> {
  return forceRefresh
    ? refreshAgentSessions(projectPath)
    : listAgentSessions(projectPath);
}

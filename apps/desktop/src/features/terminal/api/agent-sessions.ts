import { listAgentSessions } from "@/platform/agent-sessions/agent-sessions-api";
import type {
  AgentSession,
  AgentSessionsListResult,
  AgentSessionSource,
} from "@/platform/agent-sessions/agent-sessions-api";

export type { AgentSession, AgentSessionsListResult, AgentSessionSource };

export function listTerminalAgentSessions(
  projectPath: string,
): Promise<AgentSessionsListResult> {
  return listAgentSessions(projectPath);
}

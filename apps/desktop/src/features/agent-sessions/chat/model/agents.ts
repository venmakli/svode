import type {
  ChatAgentDto,
  ChatAgentsDto,
} from "@/platform/agent-setup/agent-setup-api";

export type ChatAgent = ChatAgentDto;
export type ChatAgents = ChatAgentsDto;

/** "New session" opens a chat draft only when some agent can chat now. */
export function canOpenChatDraft(agents: ChatAgents): boolean {
  return agents.agents.some((agent) => agent.offer.state === "available");
}

/**
 * The agent a new draft starts with: the agent of the device's last chat
 * session while it is available, else the first available agent in the
 * order of the agent settings.
 */
export function defaultChatAgent(agents: ChatAgents): string | null {
  const available = agents.agents.filter(
    (agent) => agent.offer.state === "available",
  );
  return (
    available.find((agent) => agent.agent === agents.last)?.agent ??
    available[0]?.agent ??
    null
  );
}

/** A remembered draft agent stays while the draft still offers it. */
export function draftAgent(
  agents: ChatAgents,
  remembered: string | null | undefined,
): string | null {
  if (remembered && agents.agents.some((agent) => agent.agent === remembered)) {
    return remembered;
  }
  return defaultChatAgent(agents);
}

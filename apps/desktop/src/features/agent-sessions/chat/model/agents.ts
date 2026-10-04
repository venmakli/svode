import type {
  ChatAgentDto,
  ChatAgentsDto,
} from "@/platform/agent-setup/agent-setup-api";

export type ChatAgent = ChatAgentDto;
export type ChatAgents = ChatAgentsDto;

/**
 * "New session" opens a chat draft only when some agent can chat now, or
 * can once the user signs in to it from the draft.
 */
export function canOpenChatDraft(agents: ChatAgents): boolean {
  return agents.agents.some(
    (agent) =>
      agent.offer.state === "available" ||
      agent.offer.state === "sign_in_required",
  );
}

/**
 * The agent a new draft starts with: the agent of the device's last chat
 * session while it is available, else the first available agent in the
 * order of the agent settings; without one, the same among the agents
 * that need sign-in.
 */
export function defaultChatAgent(agents: ChatAgents): string | null {
  for (const state of ["available", "sign_in_required"] as const) {
    const offered = agents.agents.filter((agent) => agent.offer.state === state);
    const choice =
      offered.find((agent) => agent.agent === agents.last) ?? offered[0];
    if (choice) return choice.agent;
  }
  return null;
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

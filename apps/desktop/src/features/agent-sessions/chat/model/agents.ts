import type {
  ChatAgentDto,
  ChatAgentsDto,
  DefaultAgentDto,
} from "@/platform/agent-setup/agent-setup-api";
import type { SettingValue } from "./session-controls";

export type ChatAgent = ChatAgentDto;
export type ChatAgents = ChatAgentsDto;
export type DefaultAgent = DefaultAgentDto;

const NO_VALUES: SettingValue[] = [];

/**
 * "New session" opens a chat draft only when some agent can chat now, or
 * can once the user signs in to it from the draft.
 */
export function canOpenChatDraft(agents: ChatAgents): boolean {
  return agents.agents.some(isOffered);
}

function isOffered(agent: ChatAgent): boolean {
  return (
    agent.offer.state === "available" ||
    agent.offer.state === "sign_in_required"
  );
}

/**
 * The agent a new draft starts with (Stage 11 `03`): the device's default
 * agent while the chat offers it, else the first available agent in the
 * order of the agent settings; without one, the first that needs sign-in.
 */
export function defaultChatAgent(
  agents: ChatAgents,
  defaultAgent: string | null,
): string | null {
  if (
    defaultAgent &&
    agents.agents.some(
      (agent) => agent.agent === defaultAgent && isOffered(agent),
    )
  ) {
    return defaultAgent;
  }
  for (const state of ["available", "sign_in_required"] as const) {
    const choice = agents.agents.find((agent) => agent.offer.state === state);
    if (choice) return choice.agent;
  }
  return null;
}

/** A remembered draft agent stays while the draft still offers it. */
export function draftAgent(
  agents: ChatAgents,
  remembered: string | null | undefined,
  defaultAgent: string | null,
): string | null {
  if (remembered && agents.agents.some((agent) => agent.agent === remembered)) {
    return remembered;
  }
  return defaultChatAgent(agents, defaultAgent);
}

/**
 * The values a new draft starts with for `agent`: the default agent's own
 * values, the mode included, until the draft keeps values of its own.
 */
export function defaultAgentValues(
  defaultAgent: DefaultAgent | null,
  agent: string | null,
): SettingValue[] {
  return agent && defaultAgent?.agent === agent
    ? defaultAgent.settings
    : NO_VALUES;
}

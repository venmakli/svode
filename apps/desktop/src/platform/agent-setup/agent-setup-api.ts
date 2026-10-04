import type {
  AgentCheckDto,
  AgentInfoDto,
  AgentLaunchUnavailableDto,
} from "@/platform/agent-runtime/agent-runtime-api";
import { listen, type UnlistenFn } from "@/platform/native/events";
import { invokeCommand } from "@/platform/native/invoke";
import type { TerminalSession } from "@/platform/terminal";

const CUSTOM_AGENTS_CHANGED_EVENT = "agents:custom-changed";

/** Executable, CLI version and sign-in from the bounded diagnostic commands. */
export interface AgentCliDiagnosticDto {
  adapter: string;
  status: "ready" | "missing" | "unauthenticated" | "unknown";
  executablePath: string | null;
  version: string | null;
  authenticated: boolean | null;
  code: string | null;
  message: string | null;
}

export interface AgentCliVersionRangeDto {
  minimum: string;
  testedUpTo: string;
}

export type AgentCliVersionStatusDto =
  | { state: "supported" }
  | { state: "unsupported"; minimum: string }
  | { state: "untested"; testedUpTo: string }
  | { state: "unknown" };

export type AgentAdapterInstallStateDto =
  | { state: "not_installed" }
  | { state: "installed"; version: string }
  | { state: "needs_update"; installedVersion: string };

export type AgentNodeStatusDto =
  | { state: "ready"; path: string; version: string }
  | { state: "missing" }
  | { state: "unsupported"; path: string; version: string }
  | { state: "unknown"; path: string; message: string };

export interface AgentAdapterSetupDto {
  package: string;
  pinnedVersion: string;
  install: AgentAdapterInstallStateDto;
  requiredNodeMajor: number;
  node: AgentNodeStatusDto;
}

/** What a limited agent lacks, recorded with live evidence. */
export type AgentRestrictionDto =
  | "external_sessions_unlisted"
  | "no_terminal_continuation"
  | "no_permission_requests"
  | "turn_errors_hidden";

/** Whether Svode offers the agent for chat in this version. */
export type AgentVerdictDto =
  | { state: "supported" }
  /** The first restriction is the main one. */
  | { state: "limited"; restrictions: AgentRestrictionDto[] }
  | { state: "deferred" };

/** Setup facts of one agent; reading them starts no agent process. */
export interface AgentSetupDto {
  agent: string;
  enabled: boolean;
  verdict: AgentVerdictDto;
  /** Where the vendor explains how to install the CLI. */
  installHint: string;
  /** The agent has its own sign-in command a terminal can run. */
  canSignIn: boolean;
  cli: AgentCliDiagnosticDto;
  /** `null` until the agent's version range is verified. */
  cliRange: AgentCliVersionRangeDto | null;
  cliVersion: AgentCliVersionStatusDto;
  /** `null` when the agent's ACP entrypoint is its own command. */
  adapter: AgentAdapterSetupDto | null;
}

/** `kind: "agent_adapter"` errors of the install, update and enable commands. */
export type AgentAdapterErrorDto = {
  kind: "agent_adapter";
  message: string;
} & (
  | { code: "no_adapter" }
  | { code: "node_missing"; required: number }
  | { code: "node_unsupported"; version: string; required: number }
  | { code: "node_unknown"; message: string }
  | { code: "download"; package: string; message: string }
  | { code: "integrity"; package: string }
  | { code: "package"; package: string; message: string }
  | { code: "io"; message: string }
);

export function listAgentSetups(): Promise<AgentSetupDto[]> {
  return invokeCommand<AgentSetupDto[]>("agent_setup_list");
}

/** Installs the adapter first when the agent needs one and has none. */
export function enableAgent(agent: string): Promise<AgentSetupDto> {
  return invokeCommand<AgentSetupDto>("agent_setup_enable", { agent });
}

export function disableAgent(agent: string): Promise<AgentSetupDto> {
  return invokeCommand<AgentSetupDto>("agent_setup_disable", { agent });
}

export function updateAgentAdapter(agent: string): Promise<AgentSetupDto> {
  return invokeCommand<AgentSetupDto>("agent_setup_update_adapter", { agent });
}

export function removeAgentAdapter(agent: string): Promise<AgentSetupDto> {
  return invokeCommand<AgentSetupDto>("agent_setup_remove_adapter", { agent });
}

/** Opens a terminal that runs the agent's own sign-in command. */
export function signInAgent(agent: string): Promise<TerminalSession> {
  return invokeCommand<TerminalSession>("agent_setup_sign_in", { agent });
}

/** What the user enters for a custom ACP agent. */
export interface CustomAgentDefinitionDto {
  name: string;
  command: string;
  args: string[];
  /** Not meant for secrets: keys come from the login shell environment. */
  env: Record<string, string>;
}

/** Facts of a custom agent; reading them only looks its command up. */
export interface CustomAgentSetupDto extends CustomAgentDefinitionDto {
  agent: string;
  enabled: boolean;
  /** `null` when the command is not found. */
  executablePath: string | null;
  /** What the agent declared in its last start in this app process. */
  declared: AgentInfoDto | null;
  restriction: "new_session_only" | null;
}

/** `kind: "custom_agent"` errors of the custom agent commands. */
export type CustomAgentErrorDto = {
  kind: "custom_agent";
  message: string;
} & (
  | { code: "name_missing" }
  | { code: "command_missing" }
  | { code: "invalid_variable"; name: string }
  | { code: "not_found"; agent: string }
);

export function listCustomAgents(): Promise<CustomAgentSetupDto[]> {
  return invokeCommand<CustomAgentSetupDto[]>("agent_custom_list");
}

export function addCustomAgent(
  definition: CustomAgentDefinitionDto,
): Promise<CustomAgentSetupDto> {
  return invokeCommand<CustomAgentSetupDto>("agent_custom_add", {
    definition,
  });
}

/** Changes everything but the agent's id, so its sessions keep theirs. */
export function updateCustomAgent(
  agent: string,
  definition: CustomAgentDefinitionDto,
): Promise<CustomAgentSetupDto> {
  return invokeCommand<CustomAgentSetupDto>("agent_custom_update", {
    agent,
    definition,
  });
}

/** Svode forgets the agent; its own sessions and configuration stay. */
export function removeCustomAgent(agent: string): Promise<void> {
  return invokeCommand<void>("agent_custom_remove", { agent });
}

export function setCustomAgentEnabled(
  agent: string,
  enabled: boolean,
): Promise<CustomAgentSetupDto> {
  return invokeCommand<CustomAgentSetupDto>("agent_custom_set_enabled", {
    agent,
    enabled,
  });
}

/**
 * Checks a definition before it is saved: starts the command, runs
 * `initialize` and closes it. `agent` is the custom agent being edited.
 */
export function checkCustomAgentDraft(
  agent: string | null,
  definition: CustomAgentDefinitionDto,
): Promise<AgentCheckDto> {
  return invokeCommand<AgentCheckDto>("agent_custom_check", {
    agent,
    definition,
  });
}

/** Any window added, changed or removed a custom agent. */
export function listenCustomAgentsChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>(CUSTOM_AGENTS_CHANGED_EVENT, () => handler());
}

/** One agent a new session offers for chat. */
export interface ChatAgentDto {
  agent: string;
  name: string;
  offer:
    | { state: "available" }
    | { state: "unavailable"; reason: AgentLaunchUnavailableDto };
}

export interface ChatAgentsDto {
  /** In the order of the agent settings. */
  agents: ChatAgentDto[];
  /** The agent of the last session created in the chat on this device. */
  last: string | null;
}

/** The agents a new session draft offers; starts no agent process. */
export function listChatAgents(): Promise<ChatAgentsDto> {
  return invokeCommand<ChatAgentsDto>("agent_setup_chat_agents");
}

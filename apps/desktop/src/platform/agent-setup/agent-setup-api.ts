import { invokeCommand } from "@/platform/native/invoke";
import type { TerminalSession } from "@/platform/terminal";

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

/** Whether Svode offers the agent for chat in this version. */
export type AgentVerdictDto = { state: "supported" } | { state: "deferred" };

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

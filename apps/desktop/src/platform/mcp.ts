import { invokeCommand as invoke } from "@/platform/native/invoke";
import { listen, type UnlistenFn } from "@/platform/native/events";

const MCP_STATUS_CHANGED_EVENT = "mcp:status-changed";

export type McpClientId = "claude-code" | "codex";

export type McpServerStatus = "installed" | "not_found";

export type McpClientAttentionCode =
  | "client_policy_blocked"
  | "config_unreadable"
  | "custom_conflict"
  | "higher_precedence_conflict"
  | "incomplete"
  | "mcp_start_failed"
  | "repair_failed"
  | "runtime_unavailable"
  | "skill_conflict";

export type McpClientConfigStatus =
  | "not_found"
  | "mcp_not_installed"
  | "installed"
  | "attention";

export interface McpActiveContextInput {
  projectPath: string;
  activeSpaceId?: string | null;
  activeSpacePath?: string | null;
}

export interface McpActiveContext {
  projectPath: string;
  activeSpaceId: string | null;
  activeSpacePath: string;
}

export interface McpDoctorReport {
  ok: boolean;
  command?: string | null;
  discoveryFile?: string | null;
  messages: string[];
  errors: string[];
  bridgeProtocol?: string;
  bridgeCompatible?: boolean | null;
}

export interface McpActiveRuntime {
  kind: "desktop" | "standalone";
  version: string;
}

export interface McpServerInfo {
  status: McpServerStatus;
  command?: string | null;
  version?: string | null;
  message?: string | null;
  runtime?: McpActiveRuntime | null;
}

export type McpArtifactState =
  | "absent"
  | "managed"
  | "previous"
  | "foreign"
  | "custom"
  | "unreadable";

export interface McpArtifactStatus {
  kind: "skill" | "mcp-entry";
  path: string;
  state: McpArtifactState;
}

export interface McpClientStatus {
  id: McpClientId;
  name: string;
  found: boolean;
  installed: boolean;
  managed: boolean;
  status: McpClientConfigStatus;
  attentionCode?: McpClientAttentionCode | null;
  path?: string | null;
  configPath?: string | null;
  message?: string | null;
  complete?: boolean;
  version?: string | null;
  artifacts?: McpArtifactStatus[];
}

export interface McpStatus {
  server: McpServerInfo;
  clients: McpClientStatus[];
  doctor: McpDoctorReport;
  // Version the active runtime had before this start of the app switched
  // the connected clients to its own.
  runtimeUpdatedFrom?: string | null;
}

export function setMcpActiveContext(
  context: McpActiveContextInput,
): Promise<McpActiveContext> {
  return invoke<McpActiveContext>("mcp_set_active_context", {
    projectPath: context.projectPath,
    activeSpaceId: context.activeSpaceId ?? null,
    activeSpacePath: context.activeSpacePath ?? null,
  });
}

export function clearMcpActiveContext(): Promise<void> {
  return invoke("mcp_clear_active_context");
}

export function getMcpActiveContext(): Promise<McpActiveContext | null> {
  return invoke<McpActiveContext | null>("mcp_get_active_context");
}

export function getMcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_get_status");
}

export function listenMcpStatusChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen<void>(MCP_STATUS_CHANGED_EVENT, () => handler());
}

export function installMcpClient(client: McpClientId): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_install_client", { client });
}

export function removeMcpClient(client: McpClientId): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_remove_client", { client });
}

export function printMcpConfig(client: McpClientId): Promise<string> {
  return invoke<string>("mcp_print_config", { client });
}

export function runMcpDoctor(): Promise<McpDoctorReport> {
  return invoke<McpDoctorReport>("mcp_run_doctor");
}

import { invoke } from "@tauri-apps/api/core";

export type McpClientId = "claude-code" | "codex";

export type McpServerStatus = "installed" | "not_found" | "version_mismatch";

export type McpClientConfigStatus =
  | "not_found"
  | "mcp_not_installed"
  | "installed"
  | "update_needed";

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

export interface McpManualConfig {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpDoctorReport {
  ok: boolean;
  command?: string | null;
  discoveryFile?: string | null;
  messages: string[];
  errors: string[];
}

export interface McpServerInfo {
  status: McpServerStatus;
  command?: string | null;
  version?: string | null;
  message?: string | null;
}

export interface McpClientStatus {
  id: McpClientId;
  name: string;
  found: boolean;
  installed: boolean;
  status: McpClientConfigStatus;
  path?: string | null;
  configPath?: string | null;
  message?: string | null;
}

export interface McpStatus {
  server: McpServerInfo;
  clients: McpClientStatus[];
  manualConfig: McpManualConfig;
  doctor: McpDoctorReport;
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

export function installMcpClient(client: McpClientId): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_install_client", { client });
}

export function removeMcpClient(client: McpClientId): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_remove_client", { client });
}

export function printMcpConfig(
  client?: McpClientId | null,
): Promise<McpManualConfig> {
  return invoke<McpManualConfig>("mcp_print_config", { client });
}

export function runMcpDoctor(): Promise<McpDoctorReport> {
  return invoke<McpDoctorReport>("mcp_run_doctor");
}

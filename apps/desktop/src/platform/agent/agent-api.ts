import { invokeCommand } from "@/platform/native/invoke";

export interface AvailableAgentDto {
  name: string;
  path: string;
  version: string | null;
  authStatus: string;
  docsUrl: string;
}

export interface ModelOptionDto {
  id: string;
  name: string;
  description: string;
}

export interface SymlinkHealthReportDto {
  ok: number;
  restored: number;
  errors: string[];
}

export interface SetupCliSymlinksInputDto extends Record<string, unknown> {
  spacePath: string;
  cliName: string;
  projectPath?: string | null;
}

export function listAvailableAgents(): Promise<AvailableAgentDto[]> {
  return invokeCommand<AvailableAgentDto[]>("agent_list_available");
}

export function listAgentModels(spacePath: string): Promise<ModelOptionDto[]> {
  return invokeCommand<ModelOptionDto[]>("agent_list_models", { spacePath });
}

export function readAgentsMd(spacePath: string): Promise<string | null> {
  return invokeCommand<string | null>("read_agents_md", { spacePath });
}

export function setupCliSymlinks(
  input: SetupCliSymlinksInputDto,
): Promise<string[]> {
  return invokeCommand<string[]>("setup_cli_symlinks_cmd", input);
}

export function teardownCliSymlinks(
  input: SetupCliSymlinksInputDto,
): Promise<void> {
  return invokeCommand<void>("teardown_cli_symlinks_cmd", input);
}

export function checkSymlinkHealth(
  spacePath: string,
  cliName: string,
): Promise<SymlinkHealthReportDto> {
  return invokeCommand<SymlinkHealthReportDto>("check_symlink_health", {
    spacePath,
    cliName,
  });
}

import { invokeCommand } from "@/platform/native/invoke";

export interface ModelOptionDto {
  id: string;
  name: string;
  description: string;
}

export function listAgentModels(spacePath: string): Promise<ModelOptionDto[]> {
  return invokeCommand<ModelOptionDto[]>("agent_list_models", { spacePath });
}

export function readAgentsMd(spacePath: string): Promise<string | null> {
  return invokeCommand<string | null>("read_agents_md", { spacePath });
}

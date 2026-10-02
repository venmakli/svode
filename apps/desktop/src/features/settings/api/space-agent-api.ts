import {
  listAgentModels as listPlatformAgentModels,
  readAgentsMd as readPlatformAgentsMd,
} from "@/platform/agent/agent-api";

import type { ModelOption } from "@/features/chat";

export function listAgentModels(spacePath: string): Promise<ModelOption[]> {
  return listPlatformAgentModels(spacePath);
}

export function readAgentsMd(spacePath: string): Promise<string | null> {
  return readPlatformAgentsMd(spacePath);
}

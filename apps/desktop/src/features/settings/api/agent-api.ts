import {
  checkSymlinkHealth as checkPlatformSymlinkHealth,
  listAvailableAgents as listPlatformAvailableAgents,
} from "@/platform/agent/agent-api";

import type { AvailableAgent, SymlinkHealthReport } from "../model";

export function listAvailableAgents(): Promise<AvailableAgent[]> {
  return listPlatformAvailableAgents();
}

export function checkSymlinkHealth(
  spacePath: string,
  cliName: string,
): Promise<SymlinkHealthReport> {
  return checkPlatformSymlinkHealth(spacePath, cliName);
}

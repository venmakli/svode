import { invokeCommand } from "@/platform/native/invoke";

import type { AvailableAgent, SymlinkHealthReport } from "../model";

export function listAvailableAgents(): Promise<AvailableAgent[]> {
  return invokeCommand<AvailableAgent[]>("agent_list_available");
}

export function checkSymlinkHealth(
  spacePath: string,
  cliName: string,
): Promise<SymlinkHealthReport> {
  return invokeCommand<SymlinkHealthReport>("check_symlink_health", {
    spacePath,
    cliName,
  });
}

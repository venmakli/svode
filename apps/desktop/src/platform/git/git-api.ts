import { invokeCommand } from "@/platform/native/invoke";
import type { GitAvailabilityDto, GitStatusDto } from "./git-types";

export function checkGitAvailability(): Promise<GitAvailabilityDto> {
  return invokeCommand<GitAvailabilityDto>("git_check_availability");
}

export function getGitStatus(spacePath: string): Promise<GitStatusDto> {
  return invokeCommand<GitStatusDto>("git_status", { spacePath });
}

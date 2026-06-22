import { checkGitAvailability } from "@/platform/git/git-api";
import type { GitAvailability } from "../model";

export function getGitAvailability(): Promise<GitAvailability> {
  return checkGitAvailability();
}

import { checkGitAvailability } from "@/platform/git/git-api";
import type { GitAvailability } from "../model";
import { toGitAvailability } from "./git-mappers";

export function getGitAvailability(): Promise<GitAvailability> {
  return checkGitAvailability().then(toGitAvailability);
}

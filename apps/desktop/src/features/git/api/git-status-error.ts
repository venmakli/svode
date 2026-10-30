import { toGitStatusTimeoutDto } from "@/platform/git/status-errors";
import type { GitStatusFailure } from "../model/types";

export function gitStatusFailureFromError(error: unknown): GitStatusFailure {
  const timeout = toGitStatusTimeoutDto(error);
  return timeout
    ? { kind: "timed_out", repository: timeout.repository }
    : { kind: "unavailable" };
}

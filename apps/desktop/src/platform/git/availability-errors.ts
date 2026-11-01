/**
 * Git missing or older than the minimum Svode supports: the refusal any Git
 * command returns before it runs, answered by the Git availability check.
 */
export function isGitUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("kind" in error)) return false;
  return error.kind === "git_not_found" || error.kind === "git_unsupported";
}

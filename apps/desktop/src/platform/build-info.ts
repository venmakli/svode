export function getBuildCommit(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_SVODE_BUILD_COMMIT?.trim() ?? "";
}

import type { ExternalApp } from "./types";

/**
 * The remembered application while the OS still offers it for the target,
 * otherwise the OS default. `null` until the list is known.
 */
export function resolvePrimaryApp(
  apps: readonly ExternalApp[],
  preferredId: string | null,
): ExternalApp | null {
  return (
    apps.find((app) => app.id === preferredId) ??
    apps.find((app) => app.isDefault) ??
    null
  );
}

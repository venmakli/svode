import type { AgentContextSnapshot } from "./types";

/**
 * Whether a read of the "Context" of a Space has every item, so an item it
 * lacks is gone. Any diagnostic may have lost an item: an instruction,
 * skills, the servers of a config or the components of a plugin. The
 * personal items of an agent off in Providers are absent, not unread.
 */
export function isAgentContextReadComplete(
  snapshot: AgentContextSnapshot,
): boolean {
  return snapshot.diagnostics.length === 0;
}

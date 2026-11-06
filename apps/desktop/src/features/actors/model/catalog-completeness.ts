import type { AgentActorCatalogSnapshot } from "./agent-actor-types";
import type { ActorCatalogSnapshot } from "./types";

/** People diagnostics that lose no person: an ignored custom source. */
const personPreservingDiagnostics: ReadonlySet<string> = new Set([
  "custom_source",
]);

/**
 * Whether a read of the people of a repository has every person, so a person
 * it lacks is gone. A shallow clone may miss people beyond its history, and
 * any other diagnostic, known or new, may have lost the rules that name one.
 */
export function isPersonCatalogReadComplete(
  snapshot: ActorCatalogSnapshot,
): boolean {
  return (
    !snapshot.shallow &&
    snapshot.diagnostics.every((diagnostic) =>
      personPreservingDiagnostics.has(diagnostic.kind),
    )
  );
}

/**
 * Whether a read of the Agent Actors of a Space has every Agent, so an Agent
 * it lacks is gone. Any diagnostic may have lost Agents: those of an
 * unreadable own or root catalog, both copies of an ambiguous id.
 */
export function isAgentActorCatalogReadComplete(
  snapshot: AgentActorCatalogSnapshot,
): boolean {
  return snapshot.diagnostics.length === 0;
}

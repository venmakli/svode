import type { AgentActorCatalogDiagnostic } from "./agent-actor-types";

export interface AgentActorOption {
  description: string | null;
  label: string;
  ownerLabel: string;
  value: `agent:${string}`;
}

/** Selectable agents of one launch Space plus references the catalog cannot resolve. */
export interface AgentActorOptionCatalog {
  ambiguous: readonly string[];
  incomplete: boolean;
  options: readonly AgentActorOption[];
}

export interface AgentActorOptionsState extends AgentActorOptionCatalog {
  error: string | null;
  loading: boolean;
}

export type AgentActorReference =
  | { option: AgentActorOption; reference: string; status: "resolved" }
  | { reference: string; status: "loading" }
  | { reference: string; status: "missing" }
  | { reference: string; status: "ambiguous" }
  | { reference: string; status: "error" };

const AGENT_REFERENCE = /agent:[0-9a-hjkmnp-tv-z]{26}/g;

export const EMPTY_AGENT_ACTOR_OPTIONS: AgentActorOptionsState = Object.freeze({
  ambiguous: Object.freeze([]),
  error: null,
  incomplete: false,
  loading: false,
  options: Object.freeze([]),
});

export function agentActorOptionCatalogDiagnostics(
  diagnostics: readonly AgentActorCatalogDiagnostic[],
): Pick<AgentActorOptionCatalog, "ambiguous" | "incomplete"> {
  const ambiguous = new Set<string>();
  let incomplete = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "catalog_unavailable") incomplete = true;
    if (diagnostic.code !== "ambiguous_actor_id") continue;
    for (const match of diagnostic.message.matchAll(AGENT_REFERENCE)) {
      ambiguous.add(match[0]);
    }
  }
  return { ambiguous: Object.freeze([...ambiguous]), incomplete };
}

export function resolveAgentActorReference(
  state: AgentActorOptionsState,
  reference: string,
): AgentActorReference {
  const option = state.options.find(
    (candidate) => candidate.value === reference,
  );
  if (option) return { option, reference, status: "resolved" };
  if (state.loading) return { reference, status: "loading" };
  if (state.error) return { reference, status: "error" };
  if (state.ambiguous.includes(reference)) {
    return { reference, status: "ambiguous" };
  }
  if (state.incomplete) return { reference, status: "error" };
  return { reference, status: "missing" };
}

import type { AgentActorCatalogSnapshot } from "./agent-actor-types";

export type AgentActorCatalogState =
  | { phase: "initial" }
  | { error: string; phase: "blocking_error"; retrying: boolean }
  | {
      phase: "ready";
      refreshError: string | null;
      refreshing: boolean;
      snapshot: AgentActorCatalogSnapshot;
    };

export function beginAgentActorCatalogRefresh(
  state: AgentActorCatalogState,
): AgentActorCatalogState {
  if (state.phase === "ready") {
    return { ...state, refreshError: null, refreshing: true };
  }
  if (state.phase === "blocking_error") {
    return { ...state, retrying: true };
  }
  return state;
}

export function publishAgentActorCatalogSnapshot(
  state: AgentActorCatalogState,
  snapshot: AgentActorCatalogSnapshot,
): AgentActorCatalogState {
  if (
    state.phase === "ready" &&
    agentActorCatalogSignature(state.snapshot) ===
      agentActorCatalogSignature(snapshot)
  ) {
    return state.refreshError === null && !state.refreshing
      ? state
      : { ...state, refreshError: null, refreshing: false };
  }
  return {
    phase: "ready",
    refreshError: null,
    refreshing: false,
    snapshot,
  };
}

export function failAgentActorCatalogRefresh(
  state: AgentActorCatalogState,
  error: string,
): AgentActorCatalogState {
  return state.phase === "ready"
    ? { ...state, refreshError: error, refreshing: false }
    : { error, phase: "blocking_error", retrying: false };
}

export function agentActorCatalogSignature(
  snapshot: AgentActorCatalogSnapshot,
): string {
  return JSON.stringify({
    adapterDescriptors: snapshot.adapterDescriptors,
    bindingRuntime: snapshot.bindingRuntime,
    diagnostics: snapshot.diagnostics,
    fingerprints: snapshot.fingerprints,
    launchSpacePath: snapshot.launchSpacePath,
    rows: snapshot.rows,
  });
}

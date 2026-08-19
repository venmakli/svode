import type { AgentContextInstructionsSnapshot } from "./types";

interface AgentContextCatalogStateBase {
  ownerKey: string;
  targetPath: string;
}

export type AgentContextCatalogState =
  | (AgentContextCatalogStateBase & { phase: "initial" })
  | (AgentContextCatalogStateBase & {
      phase: "blocking_error";
      error: string;
      retrying: boolean;
    })
  | (AgentContextCatalogStateBase & {
      phase: "ready";
      snapshot: AgentContextInstructionsSnapshot;
      refreshError: string | null;
      retrying: boolean;
    });

export function beginAgentContextRetry(
  state: AgentContextCatalogState,
  ownerKey: string,
  targetPath: string,
): AgentContextCatalogState {
  if (state.ownerKey !== ownerKey || state.targetPath !== targetPath) {
    return { ownerKey, phase: "initial", targetPath };
  }
  if (state.phase === "blocking_error") {
    return { ...state, retrying: true };
  }
  if (state.phase === "ready") {
    return { ...state, retrying: true };
  }
  return state;
}

export function completeAgentContextRefresh(
  state: AgentContextCatalogState,
  ownerKey: string,
  targetPath: string,
  snapshot: AgentContextInstructionsSnapshot,
): AgentContextCatalogState {
  if (
    state.phase === "ready" &&
    state.ownerKey === ownerKey &&
    state.targetPath === targetPath &&
    state.snapshot.generation === snapshot.generation
  ) {
    if (!state.retrying && state.refreshError === null) return state;
    return { ...state, refreshError: null, retrying: false };
  }
  return {
    ownerKey,
    phase: "ready",
    refreshError: null,
    retrying: false,
    snapshot,
    targetPath,
  };
}

export function failAgentContextRefresh(
  state: AgentContextCatalogState,
  ownerKey: string,
  targetPath: string,
  error: string,
): AgentContextCatalogState {
  if (
    state.phase === "ready" &&
    state.ownerKey === ownerKey &&
    state.targetPath === targetPath
  ) {
    return { ...state, refreshError: error, retrying: false };
  }
  return {
    error,
    ownerKey,
    phase: "blocking_error",
    retrying: false,
    targetPath,
  };
}

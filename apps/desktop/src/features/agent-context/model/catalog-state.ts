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
    })
  | (AgentContextCatalogStateBase & {
      phase: "ready";
      snapshot: AgentContextInstructionsSnapshot;
      refreshing: boolean;
      refreshError: string | null;
    });

export function beginAgentContextRefresh(
  state: AgentContextCatalogState,
  ownerKey: string,
  targetPath: string,
): AgentContextCatalogState {
  if (
    state.phase !== "ready" ||
    state.ownerKey !== ownerKey ||
    state.targetPath !== targetPath
  ) {
    return { ownerKey, phase: "initial", targetPath };
  }
  return { ...state, refreshing: true, refreshError: null };
}

export function completeAgentContextRefresh(
  ownerKey: string,
  targetPath: string,
  snapshot: AgentContextInstructionsSnapshot,
): AgentContextCatalogState {
  return {
    ownerKey,
    phase: "ready",
    refreshError: null,
    refreshing: false,
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
    return { ...state, refreshError: error, refreshing: false };
  }
  return { error, ownerKey, phase: "blocking_error", targetPath };
}

import type { ActorCatalogSnapshot } from "./types";

export type ActorCatalogState =
  | {
      phase: "initial";
      spacePath: string;
    }
  | {
      error: string;
      phase: "blocking_error";
      spacePath: string;
    }
  | {
      phase: "ready";
      refreshError: string | null;
      refreshing: boolean;
      snapshot: ActorCatalogSnapshot;
      spacePath: string;
    };

export function beginActorCatalogRefresh(
  state: ActorCatalogState,
  spacePath: string,
): ActorCatalogState {
  return state.spacePath === spacePath && state.phase === "ready"
    ? { ...state, refreshError: null, refreshing: true }
    : { phase: "initial", spacePath };
}

export function completeActorCatalogRefresh(
  spacePath: string,
  snapshot: ActorCatalogSnapshot,
): ActorCatalogState {
  return {
    phase: "ready",
    refreshError: null,
    refreshing: false,
    snapshot,
    spacePath,
  };
}

export function failActorCatalogRefresh(
  state: ActorCatalogState,
  spacePath: string,
  error: string,
): ActorCatalogState {
  return state.spacePath === spacePath && state.phase === "ready"
    ? { ...state, refreshError: error, refreshing: false }
    : { error, phase: "blocking_error", spacePath };
}

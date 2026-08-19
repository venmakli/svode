import type { ActorCatalogSnapshot } from "./types";

export type ActorCatalogState =
  | {
      phase: "initial";
      spacePath: string;
    }
  | {
      error: string;
      phase: "blocking_error";
      retrying: boolean;
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
    : state.spacePath === spacePath && state.phase === "blocking_error"
      ? { ...state, retrying: true }
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

export function publishActorCatalogSnapshot(
  state: ActorCatalogState,
  spacePath: string,
  snapshot: ActorCatalogSnapshot,
): ActorCatalogState {
  if (
    state.phase === "ready" &&
    state.spacePath === spacePath &&
    state.snapshot.repositoryId === snapshot.repositoryId &&
    state.snapshot.generation === snapshot.generation
  ) {
    return state.refreshError === null && !state.refreshing
      ? state
      : { ...state, refreshError: null, refreshing: false };
  }
  return completeActorCatalogRefresh(spacePath, snapshot);
}

export function failActorCatalogRefresh(
  state: ActorCatalogState,
  spacePath: string,
  error: string,
): ActorCatalogState {
  return state.spacePath === spacePath && state.phase === "ready"
    ? { ...state, refreshError: error, refreshing: false }
    : { error, phase: "blocking_error", retrying: false, spacePath };
}

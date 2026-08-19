import type { RoutineCatalogSnapshot, RoutineCatalogState } from "./types";

export function beginRoutineCatalogRefresh(
  state: RoutineCatalogState,
): RoutineCatalogState {
  if (state.phase === "ready") {
    return { ...state, refreshError: null, refreshing: true };
  }
  if (state.phase === "blocking_error") {
    return { ...state, retrying: true };
  }
  return state;
}

export function completeRoutineCatalogRefresh(
  snapshot: RoutineCatalogSnapshot,
): RoutineCatalogState {
  return {
    phase: "ready",
    refreshError: null,
    refreshing: false,
    snapshot,
  };
}

export function publishRoutineCatalogSnapshot(
  state: RoutineCatalogState,
  snapshot: RoutineCatalogSnapshot,
): RoutineCatalogState {
  if (
    state.phase === "ready" &&
    state.snapshot.catalogFingerprint === snapshot.catalogFingerprint
  ) {
    return state.refreshError === null && !state.refreshing
      ? state
      : { ...state, refreshError: null, refreshing: false };
  }
  return completeRoutineCatalogRefresh(snapshot);
}

export function failRoutineCatalogRefresh(
  state: RoutineCatalogState,
  message: string,
): RoutineCatalogState {
  return state.phase === "ready"
    ? { ...state, refreshError: message, refreshing: false }
    : { error: message, phase: "blocking_error", retrying: false };
}

import type { RoutineCatalogSnapshot, RoutineCatalogState } from "./types";

export function beginRoutineCatalogRefresh(
  state: RoutineCatalogState,
): RoutineCatalogState {
  return state.phase === "ready"
    ? { ...state, refreshError: null, refreshing: true }
    : state;
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

export function failRoutineCatalogRefresh(
  state: RoutineCatalogState,
  message: string,
): RoutineCatalogState {
  return state.phase === "ready"
    ? { ...state, refreshError: message, refreshing: false }
    : { error: message, phase: "blocking_error" };
}

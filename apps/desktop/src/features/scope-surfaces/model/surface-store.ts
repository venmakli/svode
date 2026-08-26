import { create } from "zustand";
import type { ScopeOwnerKey, ScopeSurfaceId } from "./types";

interface ScopeSurfaceState {
  surfaceByOwnerKey: Partial<Record<ScopeOwnerKey, ScopeSurfaceId>>;
  openRequestKeyByOwnerKey: Partial<Record<ScopeOwnerKey, number>>;
  setSurface: (ownerKey: ScopeOwnerKey, surfaceId: ScopeSurfaceId) => void;
  applyOpenRequest: (
    ownerKey: ScopeOwnerKey,
    requestKey: number,
    surfaceId: ScopeSurfaceId,
  ) => void;
  retargetOwner: (fromOwnerKey: ScopeOwnerKey, ownerKey: ScopeOwnerKey) => void;
  clearSurface: (ownerKey: ScopeOwnerKey) => void;
}

export const useScopeSurfaceStore = create<ScopeSurfaceState>((set) => ({
  surfaceByOwnerKey: {},
  openRequestKeyByOwnerKey: {},
  setSurface: (ownerKey, surfaceId) => {
    set((state) => ({
      surfaceByOwnerKey: {
        ...state.surfaceByOwnerKey,
        [ownerKey]: surfaceId,
      },
    }));
  },
  applyOpenRequest: (ownerKey, requestKey, surfaceId) => {
    set((state) => {
      if (state.openRequestKeyByOwnerKey[ownerKey] === requestKey) return state;
      return {
        surfaceByOwnerKey: {
          ...state.surfaceByOwnerKey,
          [ownerKey]: surfaceId,
        },
        openRequestKeyByOwnerKey: {
          ...state.openRequestKeyByOwnerKey,
          [ownerKey]: requestKey,
        },
      };
    });
  },
  retargetOwner: (fromOwnerKey, ownerKey) => {
    set((state) => {
      if (fromOwnerKey === ownerKey) return state;
      const previousSurface = state.surfaceByOwnerKey[fromOwnerKey];
      const previousRequest = state.openRequestKeyByOwnerKey[fromOwnerKey];
      if (previousSurface === undefined && previousRequest === undefined) {
        return state;
      }
      const nextSurfaces = { ...state.surfaceByOwnerKey };
      const nextRequests = { ...state.openRequestKeyByOwnerKey };
      if (previousSurface !== undefined) {
        nextSurfaces[ownerKey] = previousSurface;
      }
      if (previousRequest !== undefined) {
        nextRequests[ownerKey] = previousRequest;
      }
      delete nextSurfaces[fromOwnerKey];
      delete nextRequests[fromOwnerKey];
      return {
        surfaceByOwnerKey: nextSurfaces,
        openRequestKeyByOwnerKey: nextRequests,
      };
    });
  },
  clearSurface: (ownerKey) => {
    set((state) => {
      if (
        !(ownerKey in state.surfaceByOwnerKey) &&
        !(ownerKey in state.openRequestKeyByOwnerKey)
      ) {
        return state;
      }
      const nextSurfaces = { ...state.surfaceByOwnerKey };
      const nextRequests = { ...state.openRequestKeyByOwnerKey };
      delete nextSurfaces[ownerKey];
      delete nextRequests[ownerKey];
      return {
        surfaceByOwnerKey: nextSurfaces,
        openRequestKeyByOwnerKey: nextRequests,
      };
    });
  },
}));

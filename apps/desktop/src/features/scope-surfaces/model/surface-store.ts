import { create } from "zustand";
import type { ScopeOwnerKey, ScopeSurfaceId } from "./types";

interface ScopeSurfaceState {
  surfaceByOwnerKey: Partial<Record<ScopeOwnerKey, ScopeSurfaceId>>;
  setSurface: (ownerKey: ScopeOwnerKey, surfaceId: ScopeSurfaceId) => void;
  clearSurface: (ownerKey: ScopeOwnerKey) => void;
}

export const useScopeSurfaceStore = create<ScopeSurfaceState>((set) => ({
  surfaceByOwnerKey: {},
  setSurface: (ownerKey, surfaceId) => {
    set((state) => ({
      surfaceByOwnerKey: {
        ...state.surfaceByOwnerKey,
        [ownerKey]: surfaceId,
      },
    }));
  },
  clearSurface: (ownerKey) => {
    set((state) => {
      if (!(ownerKey in state.surfaceByOwnerKey)) return state;
      const next = { ...state.surfaceByOwnerKey };
      delete next[ownerKey];
      return { surfaceByOwnerKey: next };
    });
  },
}));

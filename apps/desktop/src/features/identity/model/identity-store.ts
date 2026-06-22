import { create } from "zustand";
import { getGlobalIdentity, saveGlobalIdentity } from "../api";
import type { GitIdentity, GlobalIdentityResult } from "./types";

interface IdentityState {
  global: GitIdentity | null;
  source: "global" | "missing";
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  refreshVersion: number;
  load: () => Promise<void>;
  saveGlobal: (name: string, email: string) => Promise<void>;
  bumpRefreshVersion: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message || "Unknown identity load error";
  if (typeof error === "string") return error || "Unknown identity load error";
  return "Unknown identity load error";
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  global: null,
  source: "missing",
  loaded: false,
  loading: false,
  loadError: null,
  refreshVersion: 0,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const result: GlobalIdentityResult = await getGlobalIdentity();
      set({
        global: result.global,
        source: result.source,
        loaded: true,
        loading: false,
        loadError: null,
        refreshVersion: get().refreshVersion + 1,
      });
    } catch (error) {
      set({
        loading: false,
        loadError: errorMessage(error),
      });
      throw error;
    }
  },

  saveGlobal: async (name, email) => {
    await saveGlobalIdentity(name, email);
    await get().load();
  },

  bumpRefreshVersion: () =>
    set((s) => ({ refreshVersion: s.refreshVersion + 1 })),
}));

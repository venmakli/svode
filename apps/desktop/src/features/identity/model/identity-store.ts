import { create } from "zustand";
import { getGlobalIdentity, saveGlobalIdentity } from "../api";
import type { GitIdentity, GlobalIdentityResult } from "./types";

interface IdentityState {
  global: GitIdentity | null;
  source: "global" | "missing";
  loaded: boolean;
  refreshVersion: number;
  load: () => Promise<void>;
  saveGlobal: (name: string, email: string) => Promise<void>;
  bumpRefreshVersion: () => void;
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  global: null,
  source: "missing",
  loaded: false,
  refreshVersion: 0,

  load: async () => {
    const result: GlobalIdentityResult = await getGlobalIdentity();
    set({
      global: result.global,
      source: result.source,
      loaded: true,
      refreshVersion: get().refreshVersion + 1,
    });
  },

  saveGlobal: async (name, email) => {
    await saveGlobalIdentity(name, email);
    await get().load();
  },

  bumpRefreshVersion: () =>
    set((s) => ({ refreshVersion: s.refreshVersion + 1 })),
}));

import { create } from "zustand";
import { getGlobalIdentity, saveGlobalIdentity } from "../api";
import type {
  GitIdentity,
  GlobalIdentityMutationResult,
  GlobalIdentityResult,
} from "./types";

interface IdentityState {
  global: GitIdentity | null;
  source: "global" | "missing";
  fingerprint: string;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  requestGeneration: number;
  refreshVersion: number;
  load: () => Promise<GlobalIdentityResult>;
  saveGlobal: (
    name: string,
    email: string,
    expectedFingerprint?: string,
  ) => Promise<GlobalIdentityMutationResult>;
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
  fingerprint: "",
  loaded: false,
  loading: false,
  loadError: null,
  requestGeneration: 0,
  refreshVersion: 0,

  load: async () => {
    const generation = get().requestGeneration + 1;
    set({ loading: true, requestGeneration: generation });
    try {
      const result: GlobalIdentityResult = await getGlobalIdentity();
      if (get().requestGeneration !== generation) {
        return currentResult(get());
      }
      const changed = result.fingerprint !== get().fingerprint;
      set({
        global: changed ? result.global : get().global,
        source: changed ? result.source : get().source,
        fingerprint: result.fingerprint,
        loaded: true,
        loading: false,
        loadError: null,
        refreshVersion: changed
          ? get().refreshVersion + 1
          : get().refreshVersion,
      });
      return result;
    } catch (error) {
      if (get().requestGeneration === generation) {
        set({
          loading: false,
          loadError: get().loaded ? null : errorMessage(error),
        });
      }
      throw error;
    }
  },

  saveGlobal: async (name, email, expectedFingerprint = get().fingerprint) => {
    try {
      const mutation = await saveGlobalIdentity(
        name,
        email,
        expectedFingerprint,
      );
      let canonical = mutation.canonical;
      try {
        canonical = await get().load();
      } catch (error) {
        console.error("Failed to re-read global Git identity after save:", error);
        const changed = canonical.fingerprint !== get().fingerprint;
        set({
          global: canonical.global,
          source: canonical.source,
          fingerprint: canonical.fingerprint,
          loaded: true,
          loading: false,
          loadError: null,
          refreshVersion: changed
            ? get().refreshVersion + 1
            : get().refreshVersion,
        });
      }
      return { ...mutation, canonical };
    } catch (error) {
      try {
        await get().load();
      } catch (reconcileError) {
        console.error(
          "Failed to reconcile global Git identity after save error:",
          reconcileError,
        );
      }
      throw error;
    }
  },

  bumpRefreshVersion: () =>
    set((s) => ({ refreshVersion: s.refreshVersion + 1 })),
}));

function currentResult(state: IdentityState): GlobalIdentityResult {
  return {
    global: state.global,
    source: state.source,
    fingerprint: state.fingerprint,
  };
}

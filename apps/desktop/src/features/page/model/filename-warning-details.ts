import { create } from "zustand";

import type { RepositoryAccessBlocker } from "@/features/git";

/** What a deferred rename left behind and why, shown on request. */
export interface PageFilenameWarningDetails {
  /** The file the Page still lives in, when the outcome names it. */
  path: string | null;
  cause:
    | { kind: "access"; blockers: readonly RepositoryAccessBlocker[] }
    | { kind: "dependencies"; message: string };
}

interface PageFilenameWarningDetailsState {
  /** Kept after closing so the Dialog keeps its content while it exits. */
  details: PageFilenameWarningDetails | null;
  open: boolean;
  close: () => void;
  show: (details: PageFilenameWarningDetails) => void;
}

export const usePageFilenameWarningDetails =
  create<PageFilenameWarningDetailsState>((set) => ({
    details: null,
    open: false,
    close: () => set({ open: false }),
    show: (details) => set({ details, open: true }),
  }));

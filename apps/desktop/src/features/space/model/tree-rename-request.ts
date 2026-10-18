import { create } from "zustand";

/**
 * A rename of a content tree row asked for outside the row, e.g. from the
 * header of an App home page without README. The row takes it once shown.
 */
interface TreeRenameRequestState {
  target: { spaceId: string; path: string } | null;
  request: (spaceId: string, path: string) => void;
  clear: () => void;
}

export const useTreeRenameRequest = create<TreeRenameRequestState>((set) => ({
  target: null,
  request: (spaceId, path) => set({ target: { spaceId, path } }),
  clear: () => set({ target: null }),
}));

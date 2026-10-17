import { create } from "zustand";

/**
 * A rename of a Space asked for outside its sidebar row, e.g. from the Space
 * header. The row takes it once the sidebar shows it.
 */
interface SpaceRenameRequestState {
  spaceId: string | null;
  request: (spaceId: string) => void;
  clear: () => void;
}

export const useSpaceRenameRequest = create<SpaceRenameRequestState>((set) => ({
  spaceId: null,
  request: (spaceId) => set({ spaceId }),
  clear: () => set({ spaceId: null }),
}));

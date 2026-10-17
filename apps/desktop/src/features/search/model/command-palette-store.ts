import { create } from "zustand";

interface CommandPaletteState {
  open: boolean;
  /**
   * The project Search was opened for from its Home row; null for the
   * active project of the window.
   */
  projectId: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  openProject: (projectId: string) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  projectId: null,
  setOpen: (open) => set({ open, projectId: null }),
  toggle: () => set((s) => ({ open: !s.open, projectId: null })),
  openProject: (projectId) => set({ open: true, projectId }),
}));

export function useOpenCommandPalette() {
  return useCommandPaletteStore((state) => state.setOpen);
}

export function useToggleCommandPalette() {
  return useCommandPaletteStore((state) => state.toggle);
}

/** Opens Search for a project of the Home list, active or not. */
export function useOpenProjectSearch() {
  return useCommandPaletteStore((state) => state.openProject);
}

/** The project Search was opened for; null for the active project. */
export function useSearchProjectId() {
  return useCommandPaletteStore((state) => state.projectId);
}

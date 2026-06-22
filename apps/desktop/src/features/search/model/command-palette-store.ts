import { create } from "zustand";

interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

export function useOpenCommandPalette() {
  return useCommandPaletteStore((state) => state.setOpen);
}

export function useToggleCommandPalette() {
  return useCommandPaletteStore((state) => state.toggle);
}

import { create } from "zustand";

interface LayoutState {
  activeDocument: string | null;
  chatPanelOpen: boolean;

  toggleChatPanel: () => void;
  openDocument: (path: string) => void;
  closeDocument: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  activeDocument: null,
  chatPanelOpen: true,

  toggleChatPanel: () => {
    const { activeDocument } = get();
    // Chat cannot be hidden when no document is open (Mode A)
    if (!activeDocument) return;
    set((s) => ({ chatPanelOpen: !s.chatPanelOpen }));
  },

  openDocument: (path) =>
    set({ activeDocument: path, chatPanelOpen: true }),

  closeDocument: () =>
    set({ activeDocument: null, chatPanelOpen: true }),
}));

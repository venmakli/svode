import { create } from "zustand";

type SettingsDialog = "app" | "space" | null;

interface LayoutState {
  activeDocument: string | null;
  /** Space id that owns the active document */
  activeDocumentSpaceId: string | null;
  chatPanelOpen: boolean;
  settingsDialog: SettingsDialog;
  /** Path of space whose settings are open (root or child) */
  settingsSpacePath: string | null;

  toggleChatPanel: () => void;
  openDocument: (path: string, spaceId?: string) => void;
  closeDocument: () => void;
  openAppSettings: () => void;
  openSpaceSettings: (spacePath: string) => void;
  closeSettings: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  activeDocument: null,
  activeDocumentSpaceId: null,
  chatPanelOpen: true,
  settingsDialog: null,
  settingsSpacePath: null,

  toggleChatPanel: () => {
    const { activeDocument } = get();
    if (!activeDocument) return;
    set((s) => ({ chatPanelOpen: !s.chatPanelOpen }));
  },

  openDocument: (path, spaceId?) =>
    set((s) => ({
      activeDocument: path,
      chatPanelOpen: true,
      // Preserve existing space id if not provided (e.g. rename within same space)
      activeDocumentSpaceId: spaceId ?? s.activeDocumentSpaceId,
    })),

  closeDocument: () =>
    set({ activeDocument: null, activeDocumentSpaceId: null, chatPanelOpen: true }),

  openAppSettings: () =>
    set({ settingsDialog: "app", settingsSpacePath: null }),

  openSpaceSettings: (spacePath) =>
    set({ settingsDialog: "space", settingsSpacePath: spacePath }),

  closeSettings: () =>
    set({ settingsDialog: null, settingsSpacePath: null }),
}));

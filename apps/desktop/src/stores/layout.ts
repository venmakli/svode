import { create } from "zustand";
import { ENABLE_IN_APP_CHAT } from "@/app/feature-flags";

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
  chatPanelOpen: false,
  settingsDialog: null,
  settingsSpacePath: null,

  toggleChatPanel: () => {
    if (!ENABLE_IN_APP_CHAT) return;
    const { activeDocument } = get();
    if (!activeDocument) return;
    set((s) => ({ chatPanelOpen: !s.chatPanelOpen }));
  },

  openDocument: (path, spaceId?) =>
    set((s) => ({
      activeDocument: path,
      chatPanelOpen: ENABLE_IN_APP_CHAT ? s.chatPanelOpen : false,
      // Preserve existing space id if not provided (e.g. rename within same space)
      activeDocumentSpaceId: spaceId ?? s.activeDocumentSpaceId,
    })),

  closeDocument: () =>
    set({ activeDocument: null, activeDocumentSpaceId: null, chatPanelOpen: false }),

  openAppSettings: () =>
    set({ settingsDialog: "app", settingsSpacePath: null }),

  openSpaceSettings: (spacePath) =>
    set({ settingsDialog: "space", settingsSpacePath: spacePath }),

  closeSettings: () =>
    set({ settingsDialog: null, settingsSpacePath: null }),
}));

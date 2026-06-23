import { create } from "zustand";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import { useEntrySelectionStore } from "@/features/entry/selection";

type SettingsDialog = "app" | "space" | null;
export type MainSurface = "content" | "inbox" | "sessions";

interface ShellState {
  chatPanelOpen: boolean;
  settingsDialog: SettingsDialog;
  settingsSpacePath: string | null;
  mainSurface: MainSurface;

  toggleChatPanel: () => void;
  closeChatPanel: () => void;
  openAppSettings: () => void;
  openSpaceSettings: (spacePath: string) => void;
  closeSettings: () => void;
  openContentSurface: () => void;
  openInboxSurface: () => void;
  openSessionsSurface: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  chatPanelOpen: false,
  settingsDialog: null,
  settingsSpacePath: null,
  mainSurface: "content",

  toggleChatPanel: () => {
    if (!ENABLE_IN_APP_CHAT) return;
    const { activeDocument } = useEntrySelectionStore.getState();
    if (!activeDocument) return;
    set((state) => ({ chatPanelOpen: !state.chatPanelOpen }));
  },

  closeChatPanel: () => set({ chatPanelOpen: false }),

  openAppSettings: () =>
    set({ settingsDialog: "app", settingsSpacePath: null }),

  openSpaceSettings: (spacePath) =>
    set({ settingsDialog: "space", settingsSpacePath: spacePath }),

  closeSettings: () => set({ settingsDialog: null, settingsSpacePath: null }),

  openContentSurface: () => set({ mainSurface: "content" }),
  openInboxSurface: () => set({ mainSurface: "inbox" }),
  openSessionsSurface: () => set({ mainSurface: "sessions" }),
}));

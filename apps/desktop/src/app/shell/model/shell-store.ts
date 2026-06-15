import { create } from "zustand";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import { useEntrySelectionStore } from "@/features/entry";

type SettingsDialog = "app" | "space" | null;

interface ShellState {
  chatPanelOpen: boolean;
  settingsDialog: SettingsDialog;
  settingsSpacePath: string | null;

  toggleChatPanel: () => void;
  closeChatPanel: () => void;
  openAppSettings: () => void;
  openSpaceSettings: (spacePath: string) => void;
  closeSettings: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  chatPanelOpen: false,
  settingsDialog: null,
  settingsSpacePath: null,

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
}));

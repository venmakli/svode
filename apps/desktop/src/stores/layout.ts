import { create } from "zustand";

type SettingsDialog = "app" | "project" | "workspace" | null;

interface LayoutState {
  activeDocument: string | null;
  chatPanelOpen: boolean;
  settingsDialog: SettingsDialog;
  settingsWorkspaceId: string | null;

  toggleChatPanel: () => void;
  openDocument: (path: string) => void;
  closeDocument: () => void;
  openAppSettings: () => void;
  openProjectSettings: () => void;
  openWorkspaceSettings: (workspaceId: string) => void;
  closeSettings: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  activeDocument: null,
  chatPanelOpen: true,
  settingsDialog: null,
  settingsWorkspaceId: null,

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

  openAppSettings: () =>
    set({ settingsDialog: "app", settingsWorkspaceId: null }),

  openProjectSettings: () =>
    set({ settingsDialog: "project", settingsWorkspaceId: null }),

  openWorkspaceSettings: (workspaceId) =>
    set({ settingsDialog: "workspace", settingsWorkspaceId: workspaceId }),

  closeSettings: () =>
    set({ settingsDialog: null, settingsWorkspaceId: null }),
}));

import { create } from "zustand";

type SettingsDialog = "app" | "workspace" | null;

interface LayoutState {
  activeDocument: string | null;
  /** Workspace id that owns the active document */
  activeDocumentWorkspaceId: string | null;
  chatPanelOpen: boolean;
  settingsDialog: SettingsDialog;
  /** Path of workspace whose settings are open (root or child) */
  settingsWorkspacePath: string | null;

  toggleChatPanel: () => void;
  openDocument: (path: string, workspaceId?: string) => void;
  closeDocument: () => void;
  openAppSettings: () => void;
  openWorkspaceSettings: (workspacePath: string) => void;
  closeSettings: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  activeDocument: null,
  activeDocumentWorkspaceId: null,
  chatPanelOpen: true,
  settingsDialog: null,
  settingsWorkspacePath: null,

  toggleChatPanel: () => {
    const { activeDocument } = get();
    if (!activeDocument) return;
    set((s) => ({ chatPanelOpen: !s.chatPanelOpen }));
  },

  openDocument: (path, workspaceId?) =>
    set((s) => ({
      activeDocument: path,
      chatPanelOpen: true,
      // Preserve existing workspace id if not provided (e.g. rename within same workspace)
      activeDocumentWorkspaceId: workspaceId ?? s.activeDocumentWorkspaceId,
    })),

  closeDocument: () =>
    set({ activeDocument: null, activeDocumentWorkspaceId: null, chatPanelOpen: true }),

  openAppSettings: () =>
    set({ settingsDialog: "app", settingsWorkspacePath: null }),

  openWorkspaceSettings: (workspacePath) =>
    set({ settingsDialog: "workspace", settingsWorkspacePath: workspacePath }),

  closeSettings: () =>
    set({ settingsDialog: null, settingsWorkspacePath: null }),
}));

import { create } from "zustand";
import { killTerminal, spawnTerminal } from "@/features/terminal/api/terminal";
import { clearTerminalOutput } from "@/features/terminal/lib/output-bus";
import type {
  TerminalTab,
  TerminalTarget,
} from "@/features/terminal/model/types";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_PANEL_RATIO = 0.38;
const MIN_PANEL_RATIO = 0.22;
const MAX_PANEL_RATIO = 0.72;

interface TerminalState {
  panelOpen: boolean;
  panelRatio: number;
  tabs: TerminalTab[];
  activeTabId: string | null;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: (initialTarget: TerminalTarget | null) => Promise<void>;
  setPanelRatio: (ratio: number) => void;
  createTab: (target: TerminalTarget) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  closeAllTabs: () => void;
  setActiveTab: (tabId: string) => void;
  markExited: (ptyId: string) => void;
  markError: (ptyId: string, message: string) => void;
}

function createRuntimeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clampPanelRatio(ratio: number): number {
  return Math.min(MAX_PANEL_RATIO, Math.max(MIN_PANEL_RATIO, ratio));
}

function nextActiveTabId(
  tabs: TerminalTab[],
  closingId: string,
): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  const remaining = tabs.filter((tab) => tab.id !== closingId);
  if (remaining.length === 0) return null;
  return (
    remaining[Math.min(index, remaining.length - 1)]?.id ?? remaining[0].id
  );
}

function disposeTerminalSession(ptyId: string, label: string): void {
  clearTerminalOutput(ptyId);
  killTerminal(ptyId).catch((error) => {
    console.warn(`Failed to kill ${label}:`, error);
  });
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  panelOpen: false,
  panelRatio: DEFAULT_PANEL_RATIO,
  tabs: [],
  activeTabId: null,

  openPanel: () => set({ panelOpen: true }),

  closePanel: () => set({ panelOpen: false }),

  togglePanel: async (initialTarget) => {
    const { panelOpen, tabs, createTab } = get();
    if (panelOpen) {
      set({ panelOpen: false });
      return;
    }

    set({ panelOpen: true });
    if (tabs.length === 0 && initialTarget) {
      await createTab(initialTarget);
    }
  },

  setPanelRatio: (ratio) => set({ panelRatio: clampPanelRatio(ratio) }),

  createTab: async (target) => {
    const tabId = createRuntimeId();
    const tab: TerminalTab = {
      id: tabId,
      title: target.name,
      cwd: target.path,
      scope: target.scope,
      scopeId: target.scopeId,
      ptyId: null,
      status: "spawning",
      error: null,
    };

    set((state) => ({
      panelOpen: true,
      tabs: [...state.tabs, tab],
      activeTabId: tabId,
    }));

    try {
      const session = await spawnTerminal(
        target.path,
        DEFAULT_COLS,
        DEFAULT_ROWS,
      );
      if (!get().tabs.some((item) => item.id === tabId)) {
        disposeTerminalSession(session.ptyId, "orphaned terminal session");
        return;
      }
      set((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tabId
            ? {
                ...item,
                cwd: session.cwd,
                ptyId: session.ptyId,
                status: "ready",
                error: null,
              }
            : item,
        ),
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error ?? "Terminal spawn failed");
      set((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tabId
            ? { ...item, status: "error", error: message }
            : item,
        ),
      }));
    }
  },

  closeTab: async (tabId) => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;

    if (tab.ptyId) {
      disposeTerminalSession(tab.ptyId, "terminal session");
    }

    const nextActive =
      activeTabId === tabId ? nextActiveTabId(tabs, tabId) : activeTabId;
    set((state) => ({
      tabs: state.tabs.filter((item) => item.id !== tabId),
      activeTabId: nextActive,
      panelOpen: nextActive ? state.panelOpen : false,
    }));
  },

  closeAllTabs: () => {
    const tabs = get().tabs;
    if (tabs.length === 0) return;

    set({ tabs: [], activeTabId: null, panelOpen: false });
    tabs.forEach((tab) => {
      if (tab.ptyId) {
        disposeTerminalSession(tab.ptyId, "terminal session");
      }
    });
  },

  setActiveTab: (tabId) => {
    if (!get().tabs.some((tab) => tab.id === tabId)) return;
    set({ activeTabId: tabId });
  },

  markExited: (ptyId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.ptyId === ptyId ? { ...tab, status: "exited" } : tab,
      ),
    })),

  markError: (ptyId, message) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.ptyId === ptyId ? { ...tab, status: "error", error: message } : tab,
      ),
    })),
}));

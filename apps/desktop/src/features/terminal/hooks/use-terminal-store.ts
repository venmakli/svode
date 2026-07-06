import { create } from "zustand";
import { listTerminalAgentSessions } from "@/features/terminal/api/agent-sessions";
import {
  killTerminal,
  listAgentTerminalSurfaces,
  registerAgentTerminalSession,
  spawnTerminal,
} from "@/features/terminal/api/terminal";
import { clearTerminalOutput } from "@/features/terminal/lib/output-bus";
import {
  findMatchingAgentSessionForShellTab,
  isLiveAgentTerminalSession,
  mergeAgentSessionIntoTab,
  syncTabsWithAgentSurfaces,
  targetToShellTab,
  terminalTabFromAgentSession,
} from "@/features/terminal/model/agent-session-tabs";
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
  syncAgentSurfaceTabs: () => Promise<boolean>;
  syncAgentSessionTabs: (
    projectPath: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<boolean>;
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

function resolveActiveTabId(
  tabs: TerminalTab[],
  activeTabId: string | null,
): string | null {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[0]?.id ?? null;
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
    const { panelOpen, createTab, syncAgentSessionTabs, syncAgentSurfaceTabs } =
      get();
    if (panelOpen) {
      set({ panelOpen: false });
      return;
    }

    set({ panelOpen: true });
    try {
      await syncAgentSurfaceTabs();
    } catch (error) {
      console.warn("Failed to sync terminal agent surfaces:", error);
    }

    const hasTabs = get().tabs.length > 0;
    if (!hasTabs && initialTarget) {
      await createTab(initialTarget);
    }

    if (initialTarget) {
      void syncAgentSessionTabs(initialTarget.path).catch((error) => {
        console.warn("Failed to sync terminal agent sessions:", error);
      });
    }
  },

  setPanelRatio: (ratio) => set({ panelRatio: clampPanelRatio(ratio) }),

  createTab: async (target) => {
    const tabId = createRuntimeId();
    const tab = targetToShellTab(tabId, target, new Date().toISOString());

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
        target.mcpProjectPath ?? target.path,
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

  syncAgentSurfaceTabs: async () => {
    const surfaces = await listAgentTerminalSurfaces();
    let hasTabs = false;

    set((state) => {
      const nextTabs = syncTabsWithAgentSurfaces(state.tabs, surfaces);
      hasTabs = nextTabs.length > 0;
      return {
        tabs: nextTabs,
        activeTabId: resolveActiveTabId(nextTabs, state.activeTabId),
      };
    });

    return hasTabs;
  },

  syncAgentSessionTabs: async (projectPath, options = {}) => {
    const result = await listTerminalAgentSessions(
      projectPath,
      options.forceRefresh ?? false,
    );
    const sessions = result.sessions;
    const currentTabs = get().tabs;
    const usedSessionIds = new Set<string>();
    const linkedByTabId = new Map<string, (typeof sessions)[number]>();

    for (const tab of currentTabs) {
      const match = findMatchingAgentSessionForShellTab(
        tab,
        sessions,
        usedSessionIds,
      );
      if (!match || !tab.ptyId) continue;

      try {
        await registerAgentTerminalSession({
          ptyId: tab.ptyId,
          agentSessionId: match.id,
          title: match.title,
          source: match.source,
          sourceSessionId: match.sourceSessionId,
          shellCwd: tab.cwd,
          createdAt: tab.createdAt,
        });
        usedSessionIds.add(match.id);
        linkedByTabId.set(tab.id, match);
      } catch (error) {
        console.warn("Failed to link terminal tab to agent session:", error);
      }
    }

    let hasTabs = false;
    set((state) => {
      const liveSessions = sessions.filter(isLiveAgentTerminalSession);
      const liveByPtyId = new Map(
        liveSessions
          .map((session) =>
            session.runtime?.ptyId ? [session.runtime.ptyId, session] : null,
          )
          .filter(
            (entry): entry is [string, (typeof sessions)[number]] =>
              entry !== null,
          ),
      );
      const existingPtyIds = new Set(
        state.tabs
          .map((tab) => tab.ptyId)
          .filter((ptyId): ptyId is string => Boolean(ptyId)),
      );
      const nextTabs = state.tabs.map((tab) => {
        if (tab.ptyId) {
          const liveSession = liveByPtyId.get(tab.ptyId);
          if (liveSession) {
            return mergeAgentSessionIntoTab(tab, liveSession, projectPath);
          }
        }

        const linkedSession = linkedByTabId.get(tab.id);
        return linkedSession
          ? mergeAgentSessionIntoTab(tab, linkedSession, projectPath)
          : tab;
      });

      for (const session of liveSessions) {
        const ptyId = session.runtime?.ptyId;
        if (!ptyId || existingPtyIds.has(ptyId)) continue;
        const tab = terminalTabFromAgentSession(session, projectPath);
        if (tab) {
          nextTabs.push(tab);
          existingPtyIds.add(ptyId);
        }
      }

      hasTabs = nextTabs.length > 0;
      return {
        tabs: nextTabs,
        activeTabId: resolveActiveTabId(nextTabs, state.activeTabId),
      };
    });

    return hasTabs;
  },

  setActiveTab: (tabId) => {
    if (!get().tabs.some((tab) => tab.id === tabId)) return;
    set({ activeTabId: tabId });
  },

  markExited: (ptyId) => {
    if (
      get().tabs.some(
        (tab) => tab.ptyId === ptyId && tab.origin === "agent-session",
      )
    ) {
      clearTerminalOutput(ptyId);
    }

    set((state) => {
      const nextTabs = state.tabs
        .map((tab) => {
          if (tab.ptyId !== ptyId) return tab;
          if (tab.origin === "agent-session") return null;
          return { ...tab, status: "exited" } satisfies TerminalTab;
        })
        .filter((tab): tab is TerminalTab => tab !== null);
      const activeTabId = resolveActiveTabId(nextTabs, state.activeTabId);

      return {
        tabs: nextTabs,
        activeTabId,
        panelOpen: activeTabId ? state.panelOpen : false,
      };
    });
  },

  markError: (ptyId, message) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.ptyId === ptyId ? { ...tab, status: "error", error: message } : tab,
      ),
    })),
}));

import { create } from "zustand";
import type { AgentSession } from "@/platform/agent-sessions/agent-sessions-api";
import {
  killTerminal,
  registerAgentTerminalSession,
  spawnTerminal,
} from "@/features/terminal/api/terminal";
import { clearTerminalOutput } from "@/features/terminal/lib/output-bus";
import { waitForPaneSize } from "@/features/terminal/lib/pane-size-handoff";
import {
  createInvalidationGuard,
  createLatestTaskQueue,
} from "@/features/terminal/lib/agent-session-sync";
import {
  applyAgentSessionsToTabs,
  findMatchingAgentSessionForShellTab,
  targetToShellTab,
} from "@/features/terminal/model/agent-session-tabs";
import type {
  TerminalTab,
  TerminalTarget,
} from "@/features/terminal/model/types";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const PANE_SIZE_TIMEOUT_MS = 500;
const DEFAULT_PANEL_RATIO = 0.38;
const MIN_PANEL_RATIO = 0.22;
const MAX_PANEL_RATIO = 0.72;

interface TerminalState {
  panelOpen: boolean;
  panelRatio: number;
  tabs: TerminalTab[];
  activeTabId: string | null;
  /** The tab whose terminal should take focus, renewed on every request. */
  focusRequest: { tabId: string; seq: number } | null;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: (initialTarget: TerminalTarget | null) => Promise<void>;
  setPanelRatio: (ratio: number) => void;
  createTab: (target: TerminalTarget) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  closeAllTabs: () => void;
  syncAgentSessionTabs: (sessions: AgentSession[]) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  /** Opens the panel on the tab of this PTY and focuses its terminal. */
  showTabForPty: (ptyId: string) => void;
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

const terminalTabSyncInvalidation = createInvalidationGuard();
const agentSessionSyncQueue = createLatestTaskQueue<void>();

export const useTerminalStore = create<TerminalState>((set, get) => ({
  panelOpen: false,
  panelRatio: DEFAULT_PANEL_RATIO,
  tabs: [],
  activeTabId: null,
  focusRequest: null,

  openPanel: () => set({ panelOpen: true }),

  closePanel: () => set({ panelOpen: false }),

  togglePanel: async (initialTarget) => {
    const { panelOpen, createTab } = get();
    if (panelOpen) {
      set({ panelOpen: false });
      return;
    }

    set({ panelOpen: true });
    if (get().tabs.length === 0 && initialTarget) {
      await createTab(initialTarget);
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
      // The shell pads its first prompt to the PTY width, so a PTY wider than
      // the pane leaves a stray PROMPT_SP mark above it.
      const { cols, rows } = await waitForPaneSize(
        tabId,
        { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        PANE_SIZE_TIMEOUT_MS,
      );
      if (!get().tabs.some((item) => item.id === tabId)) return;
      const session = await spawnTerminal(
        target.path,
        cols,
        rows,
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

    terminalTabSyncInvalidation.invalidate();
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
    terminalTabSyncInvalidation.invalidate();
    const tabs = get().tabs;
    set({ tabs: [], activeTabId: null, panelOpen: false });
    if (tabs.length === 0) return;

    tabs.forEach((tab) => {
      if (tab.ptyId) {
        disposeTerminalSession(tab.ptyId, "terminal session");
      }
    });
  },

  syncAgentSessionTabs: (sessions) => {
    const syncToken = terminalTabSyncInvalidation.capture();
    return agentSessionSyncQueue.run(async () => {
      if (!terminalTabSyncInvalidation.isCurrent(syncToken)) return;

      const usedSessionIds = new Set<string>();
      const linkedByTabId = new Map<string, AgentSession>();

      for (const tab of get().tabs) {
        if (!terminalTabSyncInvalidation.isCurrent(syncToken)) return;

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

      if (!terminalTabSyncInvalidation.isCurrent(syncToken)) return;

      set((state) => ({
        tabs: applyAgentSessionsToTabs(state.tabs, sessions, linkedByTabId),
      }));
    });
  },

  setActiveTab: (tabId) => {
    if (!get().tabs.some((tab) => tab.id === tabId)) return;
    set({ activeTabId: tabId });
  },

  showTabForPty: (ptyId) => {
    const tab = get().tabs.find((item) => item.ptyId === ptyId);
    if (!tab) return;
    set((state) => ({
      panelOpen: true,
      activeTabId: tab.id,
      focusRequest: {
        tabId: tab.id,
        seq: (state.focusRequest?.seq ?? 0) + 1,
      },
    }));
  },

  markExited: (ptyId) => {
    terminalTabSyncInvalidation.invalidate();
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.ptyId === ptyId ? { ...tab, status: "exited" } : tab,
      ),
    }));
  },

  markError: (ptyId, message) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.ptyId === ptyId ? { ...tab, status: "error", error: message } : tab,
      ),
    })),
}));

import { create } from "zustand";
import { ENABLE_IN_APP_CHAT } from "@/app/config/feature-flags";
import { getActiveContentPath } from "@/features/artifact";
import type {
  AgentSessionOpenRequest,
  AgentSessionOpenTarget,
} from "@/features/agent-sessions";
import type {
  KnowledgeGraphOpenRequest,
  KnowledgeGraphState,
} from "@/features/knowledge";
import type {
  AppSettingsSection,
  SettingsDestination,
} from "@/features/settings";

export type MainSurface = "content" | "sessions" | "graph";

const SIDEBAR_WIDTH_STORAGE_KEY = "svode:shell:sidebar-width";

export const SHELL_SIDEBAR_WIDTH_DEFAULT = 280;
export const SHELL_SIDEBAR_WIDTH_MIN = 240;
export const SHELL_SIDEBAR_WIDTH_MAX = 420;

interface ShellState {
  chatPanelOpen: boolean;
  settingsDestination: SettingsDestination | null;
  mainSurface: MainSurface;
  agentSessionOpenRequest: AgentSessionOpenRequest | null;
  nextAgentSessionOpenRequestKey: number;
  knowledgeGraphOpenRequest: KnowledgeGraphOpenRequest | null;
  nextKnowledgeGraphOpenRequestKey: number;
  sidebarWidth: number;

  toggleChatPanel: () => void;
  closeChatPanel: () => void;
  commitSidebarWidth: (width: number) => void;
  openAppSettings: (section?: AppSettingsSection) => void;
  openSpaceSettings: (
    spacePath: string,
    destination?: "general" | "git",
  ) => void;
  closeSettings: () => void;
  openContentSurface: () => void;
  openSessionsSurface: (target?: AgentSessionOpenTarget) => void;
  openGraphSurface: (state: KnowledgeGraphState) => void;
}

function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return SHELL_SIDEBAR_WIDTH_DEFAULT;

  return Math.min(
    SHELL_SIDEBAR_WIDTH_MAX,
    Math.max(SHELL_SIDEBAR_WIDTH_MIN, Math.round(width)),
  );
}

function readStoredSidebarWidth() {
  if (typeof window === "undefined") return SHELL_SIDEBAR_WIDTH_DEFAULT;

  try {
    const value = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!value) return SHELL_SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(Number.parseFloat(value));
  } catch {
    return SHELL_SIDEBAR_WIDTH_DEFAULT;
  }
}

function persistSidebarWidth(width: number) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampSidebarWidth(width)),
    );
  } catch {
    // localStorage can be unavailable in restricted WebViews; keep runtime state.
  }
}

export const useShellStore = create<ShellState>((set) => ({
  chatPanelOpen: false,
  settingsDestination: null,
  mainSurface: "content",
  agentSessionOpenRequest: null,
  nextAgentSessionOpenRequestKey: 1,
  knowledgeGraphOpenRequest: null,
  nextKnowledgeGraphOpenRequestKey: 1,
  sidebarWidth: readStoredSidebarWidth(),

  toggleChatPanel: () => {
    if (!ENABLE_IN_APP_CHAT) return;
    if (!getActiveContentPath()) return;
    set((state) => ({ chatPanelOpen: !state.chatPanelOpen }));
  },

  closeChatPanel: () => set({ chatPanelOpen: false }),

  commitSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width);
    persistSidebarWidth(sidebarWidth);
    set({ sidebarWidth });
  },

  openAppSettings: (section = "git-identity") =>
    set({ settingsDestination: { scope: "app", section } }),

  openSpaceSettings: (spacePath, section = "general") =>
    set({ settingsDestination: { scope: "project", section, spacePath } }),

  closeSettings: () => set({ settingsDestination: null }),

  openContentSurface: () => set({ mainSurface: "content" }),
  openSessionsSurface: (target) =>
    set((state) => {
      if (!target) {
        return { agentSessionOpenRequest: null, mainSurface: "sessions" };
      }
      return {
        agentSessionOpenRequest: {
          ...target,
          requestKey: state.nextAgentSessionOpenRequestKey,
        },
        mainSurface: "sessions",
        nextAgentSessionOpenRequestKey:
          state.nextAgentSessionOpenRequestKey + 1,
      };
    }),
  openGraphSurface: (graphState) =>
    set((state) => ({
      knowledgeGraphOpenRequest: {
        ...graphState,
        requestKey: state.nextKnowledgeGraphOpenRequestKey,
      },
      nextKnowledgeGraphOpenRequestKey:
        state.nextKnowledgeGraphOpenRequestKey + 1,
      mainSurface: "graph",
    })),
}));

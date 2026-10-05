import { create } from "zustand";
import type {
  AgentSessionOpenOptions,
  AgentSessionTarget,
  NewSessionDraftTarget,
} from "@/features/agent-sessions";
import type {
  KnowledgeGraphOpenRequest,
  KnowledgeGraphState,
} from "@/features/knowledge";
import type {
  AppSettingsSection,
  SettingsDestination,
} from "@/features/settings";

export type MainSurface = "content" | "graph" | "session";

const SIDEBAR_WIDTH_STORAGE_KEY = "svode:shell:sidebar-width";

export const SHELL_SIDEBAR_WIDTH_DEFAULT = 280;
export const SHELL_SIDEBAR_WIDTH_MIN = 240;
export const SHELL_SIDEBAR_WIDTH_MAX = 420;

interface ShellState {
  settingsDestination: SettingsDestination | null;
  mainSurface: MainSurface;
  /**
   * The session shown as the main area object while `mainSurface` is
   * "session"; the Graph keeps it to return to.
   */
  mainSessionTarget: AgentSessionTarget | null;
  /** A new session draft shown in the main area instead of a session. */
  mainSessionDraft: NewSessionDraftTarget | null;
  /** The main area session was opened by a move into the main area. */
  mainSessionFocus: boolean;
  /** The main area session was started for work in its terminal. */
  mainSessionFocusTerminal: boolean;
  sessionPeekTarget: AgentSessionTarget | null;
  /** A new session draft in the session peek instead of a session. */
  sessionPeekDraft: NewSessionDraftTarget | null;
  /** The peek was opened for work in the terminal, e.g. a new session. */
  sessionPeekFocusTerminal: boolean;
  knowledgeGraphOpenRequest: KnowledgeGraphOpenRequest | null;
  nextKnowledgeGraphOpenRequestKey: number;
  sidebarWidth: number;

  commitSidebarWidth: (width: number) => void;
  openAppSettings: (section?: AppSettingsSection) => void;
  openSpaceSettings: (
    spacePath: string,
    destination?: "general" | "git",
  ) => void;
  closeSettings: () => void;
  openContentSurface: () => void;
  openSessionMainSurface: (
    target: AgentSessionTarget,
    options?: { focus?: boolean; focusTerminal?: boolean },
  ) => void;
  /** A new session draft as the main area object; its first send makes it the session. */
  openSessionDraftMainSurface: (draft: NewSessionDraftTarget) => void;
  openGraphSurface: (state: KnowledgeGraphState) => void;
  /** Leaves the Graph for the object it was opened over. */
  closeGraphSurface: () => void;
  openSessionPeek: (
    target: AgentSessionTarget,
    options?: AgentSessionOpenOptions,
  ) => void;
  /** A new session draft in the session peek over the current context. */
  openSessionDraftPeek: (draft: NewSessionDraftTarget) => void;
  closeSessionPeek: () => void;
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
  settingsDestination: null,
  mainSurface: "content",
  mainSessionTarget: null,
  mainSessionDraft: null,
  mainSessionFocus: false,
  mainSessionFocusTerminal: false,
  sessionPeekTarget: null,
  sessionPeekDraft: null,
  sessionPeekFocusTerminal: false,
  knowledgeGraphOpenRequest: null,
  nextKnowledgeGraphOpenRequestKey: 1,
  sidebarWidth: readStoredSidebarWidth(),

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

  // A new main area object also ends the session peek above the old one.
  openContentSurface: () =>
    set({
      mainSurface: "content",
      mainSessionTarget: null,
      mainSessionDraft: null,
      sessionPeekTarget: null,
      sessionPeekDraft: null,
    }),
  openSessionMainSurface: (target, options) =>
    set({
      mainSurface: "session",
      mainSessionTarget: target,
      mainSessionDraft: null,
      mainSessionFocus: options?.focus ?? true,
      mainSessionFocusTerminal: options?.focusTerminal ?? false,
      sessionPeekTarget: null,
      sessionPeekDraft: null,
    }),
  openSessionDraftMainSurface: (draft) =>
    set({
      mainSurface: "session",
      mainSessionTarget: null,
      mainSessionDraft: draft,
      mainSessionFocus: true,
      mainSessionFocusTerminal: false,
      sessionPeekTarget: null,
      sessionPeekDraft: null,
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
      mainSessionFocus: false,
      mainSessionFocusTerminal: false,
      sessionPeekTarget: null,
      sessionPeekDraft: null,
    })),
  closeGraphSurface: () =>
    set((state) =>
      state.mainSurface === "graph"
        ? {
            mainSurface:
              state.mainSessionTarget || state.mainSessionDraft
                ? "session"
                : "content",
          }
        : {},
    ),
  openSessionPeek: (target, options) =>
    set({
      sessionPeekTarget: target,
      sessionPeekDraft: null,
      sessionPeekFocusTerminal: options?.focusTerminal ?? false,
    }),
  openSessionDraftPeek: (draft) =>
    set({
      sessionPeekTarget: null,
      sessionPeekDraft: draft,
      sessionPeekFocusTerminal: false,
    }),
  closeSessionPeek: () => set({ sessionPeekTarget: null, sessionPeekDraft: null }),
}));

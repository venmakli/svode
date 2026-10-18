import { create } from "zustand";
import type {
  AgentSessionOpenOptions,
  AgentSessionTarget,
  ComposerFocusRequest,
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
  /**
   * Tells one opening of a session in the main area from the next; a
   * terminal follow changes the target and keeps it.
   */
  mainSessionOpening: number;
  /** A new session draft shown in the main area instead of a session. */
  mainSessionDraft: NewSessionDraftTarget | null;
  /** The main area session was opened by a move into the main area. */
  mainSessionFocus: boolean;
  /** The main area session was started for work in its terminal. */
  mainSessionFocusTerminal: boolean;
  /** A row of the sidebar opened the main area session for its composer. */
  mainSessionComposerFocus: ComposerFocusRequest | null;
  sessionPeekTarget: AgentSessionTarget | null;
  /** Tells one opening of the session peek from the next, as for the main area. */
  sessionPeekOpening: number;
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
    options?: MainSessionOpenOptions,
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
  /**
   * The main area and the peek go on with the session the terminal they
   * show moved to, in place: `follow` gives the new target of a target it
   * moves and null for any other (DF-163 R4).
   */
  followSessionTerminal: (
    follow: (target: AgentSessionTarget) => AgentSessionTarget | null,
  ) => void;
}

export interface MainSessionOpenOptions {
  focus?: boolean;
  focusTerminal?: boolean;
  composerFocus?: ComposerFocusRequest | null;
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
  mainSessionOpening: 0,
  mainSessionDraft: null,
  mainSessionFocus: false,
  mainSessionFocusTerminal: false,
  mainSessionComposerFocus: null,
  sessionPeekTarget: null,
  sessionPeekOpening: 0,
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
    set((state) => ({
      mainSurface: "session",
      mainSessionTarget: target,
      mainSessionOpening: state.mainSessionOpening + 1,
      mainSessionDraft: null,
      mainSessionFocus: options?.focus ?? true,
      mainSessionFocusTerminal: options?.focusTerminal ?? false,
      mainSessionComposerFocus: options?.composerFocus ?? null,
      sessionPeekTarget: null,
      sessionPeekDraft: null,
    })),
  openSessionDraftMainSurface: (draft) =>
    set({
      mainSurface: "session",
      mainSessionTarget: null,
      mainSessionDraft: draft,
      mainSessionFocus: true,
      mainSessionFocusTerminal: false,
      mainSessionComposerFocus: null,
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
      mainSessionComposerFocus: null,
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
    set((state) => ({
      sessionPeekTarget: target,
      sessionPeekOpening: state.sessionPeekOpening + 1,
      sessionPeekDraft: null,
      sessionPeekFocusTerminal: options?.focusTerminal ?? false,
    })),
  openSessionDraftPeek: (draft) =>
    set({
      sessionPeekTarget: null,
      sessionPeekDraft: draft,
      sessionPeekFocusTerminal: false,
    }),
  closeSessionPeek: () => set({ sessionPeekTarget: null, sessionPeekDraft: null }),
  followSessionTerminal: (follow) =>
    set((state) => {
      const main = state.mainSessionTarget && follow(state.mainSessionTarget);
      const peek = state.sessionPeekTarget && follow(state.sessionPeekTarget);
      if (!main && !peek) return state;
      return {
        ...(main ? { mainSessionTarget: main } : {}),
        ...(peek ? { sessionPeekTarget: peek } : {}),
      };
    }),
}));

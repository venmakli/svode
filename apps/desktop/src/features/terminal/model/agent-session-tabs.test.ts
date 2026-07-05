import { expect, test } from "bun:test";
import {
  findMatchingAgentSessionForShellTab,
  isLiveAgentTerminalSession,
  syncTabsWithAgentSurfaces,
  targetToShellTab,
  terminalTabFromAgentSession,
} from "./agent-session-tabs";
import type { AgentSession } from "@/features/terminal/api/agent-sessions";
import type { TerminalAgentSurface, TerminalTab } from "./types";

function session(overrides: Partial<AgentSession> & Pick<AgentSession, "id">) {
  const base: AgentSession = {
    id: overrides.id,
    source: "codex",
    sourceSessionId:
      overrides.sourceSessionId ?? overrides.id.replace(/^.+:/, ""),
    title: overrides.title ?? "Fix auth flow",
    titleSource: "first-user-prompt",
    status: overrides.status ?? "done",
    activeFlags: overrides.activeFlags ?? [],
    statusSource: overrides.statusSource ?? "fallback",
    statusConfidence: overrides.statusConfidence ?? "weak",
    statusReason: overrides.statusReason,
    runtime: overrides.runtime,
    projectId: overrides.projectId,
    projectPath: overrides.projectPath ?? "/repo",
    scopeKind: overrides.scopeKind ?? "project",
    scopeStatus: overrides.scopeStatus ?? "ready",
    spaceId: overrides.spaceId,
    spacePath: overrides.spacePath,
    scopeConfidence: overrides.scopeConfidence ?? "exact",
    cwd: overrides.cwd ?? "/repo",
    startedAt: overrides.startedAt,
    lastActivityAt: overrides.lastActivityAt ?? "2026-07-05T10:00:00Z",
    waitingSince: overrides.waitingSince,
    durationMs: overrides.durationMs,
    resumeCommand: overrides.resumeCommand,
    sourceFile: overrides.sourceFile,
    counts: overrides.counts,
    capabilities: overrides.capabilities ?? {
      canResume: true,
      canRevealFile: true,
      hasReadableLog: true,
    },
    pinned: overrides.pinned ?? false,
    sourceMeta: overrides.sourceMeta ?? {
      historyPresent: true,
      detailPresent: false,
      sessionIndexPresent: false,
      detailFileCount: 0,
      historyLineCount: 1,
      detailLineCount: 0,
      malformedLineCount: 0,
      functionCallCount: 0,
      notes: [],
    },
  };

  return { ...base, ...overrides } satisfies AgentSession;
}

function shellTab(overrides: Partial<TerminalTab> = {}) {
  return {
    ...targetToShellTab(
      "tab-shell",
      {
        scope: "project",
        scopeId: "root",
        name: "Project",
        path: "/repo",
        secondaryPath: "/repo",
      },
      "2026-07-05T10:00:00Z",
    ),
    ptyId: "pty-shell",
    status: "ready",
    ...overrides,
  } satisfies TerminalTab;
}

function surface(
  overrides: Partial<TerminalAgentSurface> &
    Pick<TerminalAgentSurface, "ptyId" | "agentSessionId">,
) {
  return {
    ptyId: overrides.ptyId,
    agentSessionId: overrides.agentSessionId,
    title: overrides.title ?? "Live task",
    source: overrides.source ?? "codex",
    sourceSessionId: overrides.sourceSessionId ?? overrides.agentSessionId,
    shellCwd: overrides.shellCwd ?? "/repo",
    createdAt: overrides.createdAt ?? "2026-07-05T10:02:00Z",
    lastOutputAt: overrides.lastOutputAt,
    lastInputAt: overrides.lastInputAt,
  } satisfies TerminalAgentSurface;
}

test("builds a terminal tab for a live agent session pty", () => {
  const item = session({
    id: "codex:live",
    title: "Release notes",
    runtime: { live: true, ptyId: "pty-live" },
  });

  const tab = terminalTabFromAgentSession(item, "/repo");

  expect(isLiveAgentTerminalSession(item)).toBe(true);
  expect(tab?.title).toBe("Release notes");
  expect(tab?.ptyId).toBe("pty-live");
  expect(tab?.origin).toBe("agent-session");
  expect(tab?.agentSessionId).toBe("codex:live");
});

test("syncs live agent surfaces without keeping stale agent session tabs", () => {
  const oldAgentTab = shellTab({
    id: "agent-session:old:pty-old",
    title: "Old run",
    ptyId: "pty-old",
    origin: "agent-session",
    agentSessionId: "codex:old",
  });
  const existingShellTab = shellTab({
    id: "shell-tab",
    ptyId: "pty-shell",
  });

  const tabs = syncTabsWithAgentSurfaces(
    [oldAgentTab, existingShellTab],
    [surface({ ptyId: "pty-live", agentSessionId: "codex:live" })],
  );

  expect(tabs.some((tab) => tab.id === "agent-session:old:pty-old")).toBe(
    false,
  );
  expect(tabs.find((tab) => tab.id === "shell-tab")?.origin).toBe("shell");
  expect(
    tabs.find((tab) => tab.id === "agent-session:codex:live:pty-live")?.title,
  ).toBe("Live task");
});

test("syncs a matching shell tab into the registered agent surface", () => {
  const shell = shellTab({
    id: "shell-live",
    ptyId: "pty-live",
    createdAt: "2026-07-05T10:00:00Z",
  });

  const tabs = syncTabsWithAgentSurfaces(
    [shell],
    [
      surface({
        ptyId: "pty-live",
        agentSessionId: "codex:live",
        title: "Use existing tab",
      }),
    ],
  );

  expect(tabs.length).toBe(1);
  const [tab] = tabs;
  if (!tab) throw new Error("Expected a synced terminal tab");
  expect(tab.id).toBe("shell-live");
  expect(tab.origin).toBe("agent-session");
  expect(tab.title).toBe("Use existing tab");
  expect(tab.createdAt).toBe("2026-07-05T10:00:00Z");
});

test("does not match a shell tab to older agent session history", () => {
  const tab = shellTab();
  const oldSession = session({
    id: "codex:old",
    lastActivityAt: "2026-07-05T09:59:00Z",
  });

  expect(findMatchingAgentSessionForShellTab(tab, [oldSession])).toBeNull();
});

test("matches a shell tab to a new agent session in the same cwd", () => {
  const tab = shellTab();
  const newSession = session({
    id: "codex:new",
    title: "Use terminal tab",
    startedAt: "2026-07-05T10:00:10Z",
    lastActivityAt: "2026-07-05T10:01:00Z",
  });

  expect(findMatchingAgentSessionForShellTab(tab, [newSession])?.id).toBe(
    "codex:new",
  );
});

test("does not match a shell tab to an existing session with newer activity", () => {
  const tab = shellTab();
  const existing = session({
    id: "codex:existing",
    startedAt: "2026-07-05T09:30:00Z",
    lastActivityAt: "2026-07-05T10:01:00Z",
  });

  expect(findMatchingAgentSessionForShellTab(tab, [existing])).toBeNull();
});

test("does not match a shell tab to an agent session from another cwd", () => {
  const tab = shellTab();
  const other = session({
    id: "codex:other",
    cwd: "/repo/other",
    lastActivityAt: "2026-07-05T10:01:00Z",
  });

  expect(findMatchingAgentSessionForShellTab(tab, [other])).toBeNull();
});

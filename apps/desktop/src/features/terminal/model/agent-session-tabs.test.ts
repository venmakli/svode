import { expect, test } from "bun:test";
import {
  applyAgentSessionsToTabs,
  findMatchingAgentSessionForShellTab,
  targetToShellTab,
} from "./agent-session-tabs";
import type { AgentSession } from "@/platform/agent-sessions/agent-sessions-api";
import type { TerminalTab } from "./types";

function session(overrides: Partial<AgentSession> & Pick<AgentSession, "id">) {
  const base: AgentSession = {
    id: overrides.id,
    source: "codex",
    sourceSessionId:
      overrides.sourceSessionId ?? overrides.id.replace(/^.+:/, ""),
    title: overrides.title ?? "Fix auth flow",
    titleSource: "cli-title",
    status: overrides.status ?? {
      state: "idle",
      stopReason: "end_turn",
      source: "native_status_reader",
      confidence: "approximate",
    },
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
    resumeCommand: overrides.resumeCommand,
    capabilities: overrides.capabilities ?? {
      canResume: true,
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

test("session terminals opened outside the panel get no tab", () => {
  const shell = shellTab();
  const managed = session({
    id: "codex:managed",
    runtime: { live: true, ptyId: "pty-managed" },
  });

  expect(applyAgentSessionsToTabs([shell], [managed], new Map())).toEqual([
    shell,
  ]);
});

test("a shell tab shows the agent session recognized in it", () => {
  const shell = shellTab({ id: "shell-live", ptyId: "pty-live" });
  const live = session({
    id: "codex:live",
    title: "Release notes",
    runtime: { live: true, ptyId: "pty-live" },
  });

  const [tab] = applyAgentSessionsToTabs([shell], [live], new Map());
  expect(tab?.id).toBe("shell-live");
  expect(tab?.title).toBe("Release notes");
  expect(tab?.agentSessionId).toBe("codex:live");
  expect(tab?.cwd).toBe(shell.cwd);
  expect(tab?.scopeId).toBe(shell.scopeId);
});

test("a tab linked in this sync shows its session before the catalog lists the PTY", () => {
  const shell = shellTab({ id: "shell-new" });
  const linked = session({ id: "claude:new", title: "Fix login" });

  const [tab] = applyAgentSessionsToTabs(
    [shell],
    [linked],
    new Map([["shell-new", linked]]),
  );
  expect(tab?.agentSessionId).toBe("claude:new");
  expect(tab?.title).toBe("Fix login");
});

test("a tab already showing a session is not matched again", () => {
  const tab = shellTab({ agentSessionId: "codex:first" });
  const next = session({
    id: "codex:second",
    startedAt: "2026-07-05T10:00:10Z",
  });

  expect(findMatchingAgentSessionForShellTab(tab, [next])).toBeNull();
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

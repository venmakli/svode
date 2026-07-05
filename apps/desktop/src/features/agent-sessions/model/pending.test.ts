import { expect, test } from "bun:test";
import {
  buildPendingAgentSession,
  findMatchingSessionForPendingTerminal,
  pendingSessionId,
  type PendingAgentSessionTerminal,
} from "./pending";
import type { AgentSession, AgentSessionScopeGroup } from "./types";

const scope: AgentSessionScopeGroup = {
  id: "space:project:/repo",
  kind: "project",
  scopeId: "root",
  name: "Project",
  icon: null,
  path: "/repo",
  status: "ready",
};

function pending(overrides: Partial<PendingAgentSessionTerminal> = {}) {
  return {
    id: pendingSessionId("pty-new"),
    ptyId: "pty-new",
    title: "New session",
    scope,
    cwd: "/repo",
    createdAt: "2026-07-05T10:00:00Z",
    ...overrides,
  };
}

function session(overrides: Partial<AgentSession> & Pick<AgentSession, "id">) {
  const base: AgentSession = {
    id: overrides.id,
    source: "codex",
    sourceSessionId: overrides.id.replace(/^.+:/, ""),
    title: overrides.title ?? "Real session",
    titleSource: "first-user-prompt",
    status: "done",
    activeFlags: [],
    statusSource: "fallback",
    statusConfidence: "weak",
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/repo",
    cwd: "/repo",
    lastActivityAt: "2026-07-05T10:01:00Z",
    capabilities: {
      canResume: true,
      canRevealFile: true,
      hasReadableLog: true,
    },
    pinned: false,
    sourceMeta: {
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

test("builds a visible pending session backed by a managed terminal pty", () => {
  const item = buildPendingAgentSession(pending());

  expect(item.id).toBe("new-session:pty-new");
  expect(item.source).toBe("unknown");
  expect(item.title).toBe("New session");
  expect(item.runtime?.ptyId).toBe("pty-new");
  expect(item.runtime?.live).toBe(true);
});

test("matches a pending terminal to a newly discovered session by cwd and activity", () => {
  const item = pending();
  const old = session({
    id: "codex:old",
    lastActivityAt: "2026-07-05T09:59:00Z",
  });
  const discovered = session({
    id: "codex:new",
    title: "Use real title",
    lastActivityAt: "2026-07-05T10:01:00Z",
  });

  expect(
    findMatchingSessionForPendingTerminal(item, [old, discovered])?.id,
  ).toBe("codex:new");
});

test("does not match sessions from another cwd", () => {
  const item = pending();
  const other = session({
    id: "codex:other",
    cwd: "/repo/other",
    lastActivityAt: "2026-07-05T10:01:00Z",
  });

  expect(findMatchingSessionForPendingTerminal(item, [other])).toBeNull();
});

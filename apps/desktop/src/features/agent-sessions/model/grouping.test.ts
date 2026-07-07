import { expect, test } from "bun:test";
import {
  buildAgentSessionGroups,
  childSpaceScopeGroupId,
  filterAgentSessions,
  isNowSession,
  projectScopeGroupId,
} from "./grouping";
import type { AgentSession, AgentSessionScopeGroup } from "./types";

const baseTime = "2026-07-04T05:00:00Z";

function session(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id">,
): AgentSession {
  return {
    id: overrides.id,
    source: "codex",
    sourceSessionId: overrides.id.replace(/^.+:/, ""),
    title: overrides.title ?? overrides.id,
    titleSource: "session-id",
    status: overrides.status ?? "done",
    activeFlags: overrides.activeFlags ?? [],
    statusSource: overrides.statusSource ?? "fallback",
    statusConfidence: overrides.statusConfidence ?? "weak",
    scopeKind: overrides.scopeKind ?? "project",
    scopeStatus: overrides.scopeStatus ?? "ready",
    scopeConfidence: overrides.scopeConfidence ?? "exact",
    projectPath: overrides.projectPath ?? "/repo",
    spaceId: overrides.spaceId,
    spacePath: overrides.spacePath,
    cwd: overrides.cwd,
    startedAt: overrides.startedAt,
    lastActivityAt: overrides.lastActivityAt ?? baseTime,
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
    runtime: overrides.runtime,
    sourceMeta: overrides.sourceMeta ?? {
      historyPresent: false,
      detailPresent: false,
      sessionIndexPresent: false,
      detailFileCount: 0,
      historyLineCount: 0,
      detailLineCount: 0,
      malformedLineCount: 0,
      functionCallCount: 0,
      notes: [],
    },
  };
}

test("groups sessions as pinned, now, then spaces without duplicates", () => {
  const pinnedActive = session({
    id: "codex:pinned",
    pinned: true,
    status: "active",
  });
  const active = session({ id: "codex:active", status: "active" });
  const done = session({ id: "codex:done" });

  const groups = buildAgentSessionGroups({
    sessions: [pinnedActive, active, done],
  });

  expect(groups.pinned?.sessions.map((item) => item.id)).toEqual([
    "codex:pinned",
  ]);
  expect(groups.now?.sessions.map((item) => item.id)).toEqual(["codex:active"]);
  expect(
    groups.spaces.flatMap((group) => group.sessions.map((item) => item.id)),
  ).toEqual(["codex:done"]);
});

test("moves selected session with an open terminal from space into now", () => {
  const openFromSpace = session({
    id: "codex:space-open",
    status: "done",
    runtime: { live: true, ptyId: "pty-1" },
    scopeKind: "space",
    spaceId: "develop",
    spacePath: "/repo/develop",
  });

  const groups = buildAgentSessionGroups({
    sessions: [openFromSpace],
    spaceScopes: [
      scope({
        id: childSpaceScopeGroupId("develop"),
        scopeId: "develop",
        name: "Develop",
        path: "/repo/develop",
      }),
    ],
    selectedSessionId: openFromSpace.id,
    selectedStableGroupId: "space:develop",
  });

  expect(groups.now?.sessions[0]?.id).toBe(openFromSpace.id);
  expect(groups.spaces[0]?.sessions).toEqual([]);
});

test("keeps selected past session in its space before terminal opens", () => {
  const selectedPast = session({
    id: "codex:space-selected",
    status: "done",
    scopeKind: "space",
    spaceId: "develop",
    spacePath: "/repo/develop",
  });

  const groups = buildAgentSessionGroups({
    sessions: [selectedPast],
    selectedSessionId: selectedPast.id,
    selectedStableGroupId: "space:develop",
  });

  expect(groups.now).toBeNull();
  expect(groups.spaces[0]?.sessions[0]?.id).toBe(selectedPast.id);
});

test("returns selected session to space when its terminal closes", () => {
  const closed = session({
    id: "codex:space-closed",
    status: "done",
    scopeKind: "space",
    spaceId: "develop",
    spacePath: "/repo/develop",
  });

  const groups = buildAgentSessionGroups({
    sessions: [closed],
    selectedSessionId: closed.id,
    selectedStableGroupId: "space:develop",
  });

  expect(groups.now).toBeNull();
  expect(groups.spaces[0]?.sessions[0]?.id).toBe(closed.id);
});

test("now sorting puts actionable waiting above active and live terminals", () => {
  const live = session({
    id: "codex:live",
    runtime: { live: true, ptyId: "pty-live" },
  });
  const active = session({ id: "codex:active", status: "active" });
  const waiting = session({
    id: "codex:waiting",
    status: "active",
    activeFlags: ["waitingOnUserInput"],
  });

  const groups = buildAgentSessionGroups({ sessions: [live, active, waiting] });

  expect(groups.now?.sessions.map((item) => item.id)).toEqual([
    "codex:waiting",
    "codex:active",
    "codex:live",
  ]);
  expect(isNowSession(live)).toBe(true);
});

test("now sorting orders open terminals by terminal activity", () => {
  const olderSessionActivity = session({
    id: "codex:older-session-newer-terminal",
    lastActivityAt: "2026-07-04T05:00:00Z",
    runtime: {
      live: true,
      ptyId: "pty-newer",
      lastInputAt: "2026-07-04T05:30:00Z",
    },
  });
  const newerSessionActivity = session({
    id: "codex:newer-session-older-terminal",
    lastActivityAt: "2026-07-04T05:20:00Z",
    runtime: {
      live: true,
      ptyId: "pty-older",
      lastOutputAt: "2026-07-04T05:10:00Z",
    },
  });

  const groups = buildAgentSessionGroups({
    sessions: [newerSessionActivity, olderSessionActivity],
  });

  expect(groups.now?.sessions.map((item) => item.id)).toEqual([
    "codex:older-session-newer-terminal",
    "codex:newer-session-older-terminal",
  ]);
});

test("process-only runtime evidence does not make a session current", () => {
  const processOnly = session({
    id: "codex:process-only",
    runtime: { live: true, pid: 4242 },
  });

  const groups = buildAgentSessionGroups({ sessions: [processOnly] });

  expect(isNowSession(processOnly)).toBe(false);
  expect(groups.now).toBeNull();
  expect(groups.spaces[0]?.sessions[0]?.id).toBe(processOnly.id);
});

test("space pagination uses per-group visible limits", () => {
  const sessions = Array.from({ length: 12 }, (_, index) =>
    session({
      id: `codex:${index}`,
      scopeKind: "space",
      spaceId: "develop",
      spacePath: "/repo/develop",
    }),
  );

  const initial = buildAgentSessionGroups({ sessions });
  const expanded = buildAgentSessionGroups({
    sessions,
    visibleLimits: { "space:develop": 20 },
  });

  expect(initial.spaces[0]?.sessions.length).toBe(10);
  expect(initial.spaces[0]?.hasMore).toBe(true);
  expect(expanded.spaces[0]?.sessions.length).toBe(12);
  expect(expanded.spaces[0]?.hasMore).toBe(false);
});

test("includes known spaces in sidebar order with zero counts", () => {
  const rootScope = scope({
    id: projectScopeGroupId("/repo"),
    kind: "project",
    scopeId: "root",
    name: "Root",
    path: "/repo",
  });
  const complianceScope = scope({
    id: childSpaceScopeGroupId("compliance"),
    scopeId: "compliance",
    name: "Compliance",
    path: "/repo/compliance",
  });
  const developScope = scope({
    id: childSpaceScopeGroupId("develop"),
    scopeId: "develop",
    name: "Develop",
    path: "/repo/develop",
  });
  const developSession = session({
    id: "codex:develop",
    scopeKind: "space",
    spaceId: "develop",
    spacePath: "/repo/develop",
  });

  const groups = buildAgentSessionGroups({
    sessions: [developSession],
    spaceScopes: [rootScope, complianceScope, developScope],
  });

  expect(groups.spaces.map((group) => group.id)).toEqual([
    "space:project:/repo",
    "space:compliance",
    "space:develop",
  ]);
  expect(groups.spaces.map((group) => group.total)).toEqual([0, 0, 1]);
  expect(groups.spaces[2]?.sessions.map((item) => item.id)).toEqual([
    "codex:develop",
  ]);
});

test("matches known space group by path when session space id is missing", () => {
  const developScope = scope({
    id: childSpaceScopeGroupId("develop"),
    scopeId: "develop",
    name: "Develop",
    path: "/repo/develop",
  });
  const developSession = session({
    id: "codex:path-only",
    scopeKind: "space",
    spacePath: "/repo/develop",
  });

  const groups = buildAgentSessionGroups({
    sessions: [developSession],
    spaceScopes: [developScope],
  });

  expect(groups.spaces.length).toBe(1);
  expect(groups.spaces[0]?.id).toBe("space:develop");
  expect(groups.spaces[0]?.sessions[0]?.id).toBe("codex:path-only");
});

test("search uses normalized metadata only", () => {
  const sessions = [
    session({
      id: "codex:auth",
      title: "Fix auth flow",
      cwd: "/repo/develop",
      sourceFile: {
        path: "/home/user/.codex/rollout-auth.jsonl",
        mtimeMs: 1,
        sizeBytes: 10,
      },
    }),
    session({
      id: "claude-code:billing",
      source: "claude-code",
      sourceSessionId: "billing",
      title: "Billing polish",
    }),
  ];

  expect(filterAgentSessions(sessions, "claude")).toEqual([sessions[1]]);
  expect(filterAgentSessions(sessions, "develop")).toEqual([sessions[0]]);
  expect(filterAgentSessions(sessions, "secret transcript")).toEqual([]);
});

function scope(
  overrides: Partial<AgentSessionScopeGroup> &
    Pick<AgentSessionScopeGroup, "id" | "scopeId" | "name" | "path">,
): AgentSessionScopeGroup {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "space",
    scopeId: overrides.scopeId,
    name: overrides.name,
    icon: overrides.icon ?? null,
    path: overrides.path,
    status: overrides.status ?? "ready",
  };
}

import { expect, test } from "bun:test";
import {
  buildAgentSessionGroups,
  filterAgentSessions,
  isNowSession,
} from "./grouping";
import type { AgentSession } from "./types";

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
  expect(groups.spaces.flatMap((group) => group.sessions.map((item) => item.id)))
    .toEqual(["codex:done"]);
});

test("keeps selected session in its spaces group until another selection", () => {
  const openFromSpace = session({
    id: "codex:space-open",
    status: "done",
    runtime: { live: true, ptyId: "pty-1" },
    scopeKind: "space",
    spaceId: "develop",
    spacePath: "/repo/develop",
  });

  const stable = buildAgentSessionGroups({
    sessions: [openFromSpace],
    selectedSessionId: openFromSpace.id,
    selectedStableGroupId: "space:develop",
  });
  const released = buildAgentSessionGroups({
    sessions: [openFromSpace],
    selectedSessionId: "codex:other",
    selectedStableGroupId: "space:develop",
  });

  expect(stable.now).toBeNull();
  expect(stable.spaces[0]?.sessions[0]?.id).toBe(openFromSpace.id);
  expect(released.now?.sessions[0]?.id).toBe(openFromSpace.id);
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

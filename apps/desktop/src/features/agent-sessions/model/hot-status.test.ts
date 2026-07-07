import { expect, test } from "bun:test";
import { buildHotStatusSessionIds } from "./hot-status";
import type { AgentSession } from "./types";

function session(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id">,
): AgentSession {
  return {
    id: overrides.id,
    source: overrides.source ?? "codex",
    sourceSessionId:
      overrides.sourceSessionId ?? overrides.id.replace(/^.+:/, ""),
    title: overrides.title ?? overrides.id,
    titleSource: overrides.titleSource ?? "session-id",
    status: overrides.status ?? "done",
    activeFlags: overrides.activeFlags ?? [],
    statusSource: overrides.statusSource ?? "fallback",
    statusConfidence: overrides.statusConfidence ?? "weak",
    scopeKind: overrides.scopeKind ?? "project",
    scopeStatus: overrides.scopeStatus ?? "ready",
    scopeConfidence: overrides.scopeConfidence ?? "exact",
    projectPath: overrides.projectPath ?? "/repo",
    lastActivityAt: overrides.lastActivityAt ?? "2026-07-04T05:00:00Z",
    runtime: overrides.runtime,
    capabilities: overrides.capabilities ?? {
      canResume: true,
      canRevealFile: true,
      hasReadableLog: true,
    },
    pinned: overrides.pinned ?? false,
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

test("hot status ids include active, waiting, live, and selected sessions", () => {
  const ids = buildHotStatusSessionIds({
    sessions: [
      session({ id: "codex:done" }),
      session({ id: "codex:selected" }),
      session({ id: "codex:active", status: "active" }),
      session({
        id: "codex:waiting",
        status: "active",
        activeFlags: ["waitingOnApproval"],
      }),
      session({
        id: "claude-code:live",
        source: "claude-code",
        runtime: { live: true, ptyId: "pty-live" },
      }),
    ],
    selectedSessionId: "codex:selected",
  });

  expect(ids).toEqual([
    "codex:active",
    "codex:waiting",
    "claude-code:live",
    "codex:selected",
  ]);
});

test("hot status ids ignore pending and unknown source sessions", () => {
  const ids = buildHotStatusSessionIds({
    sessions: [
      session({ id: "new-session:pty-1", status: "active" }),
      session({ id: "unknown:active", source: "unknown", status: "active" }),
    ],
    selectedSessionId: "new-session:pty-1",
  });

  expect(ids).toEqual([]);
});

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
    status: overrides.status ?? {
      state: "idle",
      stopReason: "end_turn",
      source: "native_status_reader",
      confidence: "approximate",
    },
    scopeKind: overrides.scopeKind ?? "project",
    scopeStatus: overrides.scopeStatus ?? "ready",
    scopeConfidence: overrides.scopeConfidence ?? "exact",
    projectPath: overrides.projectPath ?? "/repo",
    lastActivityAt: overrides.lastActivityAt ?? "2026-07-04T05:00:00Z",
    runtime: overrides.runtime,
    capabilities: overrides.capabilities ?? {
      canResume: true,
      canOpenInChat: false,
    },
  };
}

test("hot status ids include active, waiting, live, and observed sessions", () => {
  const ids = buildHotStatusSessionIds({
    sessions: [
      session({ id: "codex:done" }),
      session({ id: "codex:selected" }),
      session({
        id: "codex:active",
        status: {
          state: "running",
          source: "native_status_reader",
          confidence: "approximate",
        },
      }),
      session({
        id: "codex:waiting",
        status: {
          state: "requires_action",
          request: "permission",
          source: "native_status_reader",
          confidence: "approximate",
        },
      }),
      session({
        id: "claude-code:live",
        source: "claude-code",
        runtime: { live: true, ptyId: "pty-live" },
      }),
    ],
    observedSessionIds: ["codex:selected"],
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
      session({
        id: "new-session:pty-1",
        status: {
          state: "running",
          source: "native_status_reader",
          confidence: "approximate",
        },
      }),
      session({
        id: "unknown:active",
        source: "unknown",
        status: {
          state: "running",
          source: "native_status_reader",
          confidence: "approximate",
        },
      }),
    ],
    observedSessionIds: ["new-session:pty-1"],
  });

  expect(ids).toEqual([]);
});

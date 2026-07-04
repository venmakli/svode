import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSession } from "../api";
import {
  SessionStatusMarker,
  statusLabel,
  statusMarkerLabel,
} from "./session-status";
import * as m from "@/paraglide/messages.js";

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "codex:session",
    source: "codex",
    sourceSessionId: "session",
    title: "Session",
    titleSource: "session-id",
    status: "done",
    activeFlags: [],
    statusSource: "fallback",
    statusConfidence: "weak",
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/repo",
    lastActivityAt: "2026-07-04T05:00:00Z",
    capabilities: {
      canResume: true,
      canRevealFile: true,
      hasReadableLog: true,
    },
    pinned: false,
    sourceMeta: {
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
    ...overrides,
  };
}

test("status label stays normalized when a terminal is open", () => {
  const doneWithOpenTerminal = session({
    status: "done",
    runtime: { live: true, ptyId: "pty-1" },
  });

  expect(statusLabel(doneWithOpenTerminal)).toBe(m.sessions_status_done());
  expect(statusMarkerLabel(doneWithOpenTerminal)).toBe(
    m.sessions_status_terminal_open(),
  );
});

test("stronger status markers are not replaced by terminal-open marker", () => {
  const failedWithOpenTerminal = session({
    status: "failed",
    runtime: { live: true, ptyId: "pty-1" },
  });
  const activeWithOpenTerminal = session({
    status: "active",
    runtime: { live: true, ptyId: "pty-1" },
  });

  expect(statusMarkerLabel(failedWithOpenTerminal)).toBe(
    m.sessions_status_failed(),
  );
  expect(statusMarkerLabel(activeWithOpenTerminal)).toBe(
    m.sessions_status_active(),
  );
});

test("waiting markers distinguish approval from user input", () => {
  const approval = session({
    status: "active",
    activeFlags: ["waitingOnApproval"],
  });
  const input = session({
    status: "active",
    activeFlags: ["waitingOnUserInput"],
  });
  const both = session({
    status: "active",
    activeFlags: ["waitingOnUserInput", "waitingOnApproval"],
  });

  expect(statusMarkerLabel(approval)).toBe(
    m.sessions_status_waiting_approval(),
  );
  expect(statusMarkerLabel(input)).toBe(m.sessions_status_waiting_input());
  expect(statusMarkerLabel(both)).toBe(m.sessions_status_waiting_approval());
  expect(
    renderToStaticMarkup(<SessionStatusMarker session={approval} />).includes(
      "lucide-message-square-warning",
    ),
  ).toBe(true);
  expect(
    renderToStaticMarkup(<SessionStatusMarker session={input} />).includes(
      "lucide-message-circle-question",
    ),
  ).toBe(true);
});

test("done sessions render without a status marker", () => {
  expect(renderToStaticMarkup(<SessionStatusMarker session={session()} />)).toBe(
    "",
  );
});

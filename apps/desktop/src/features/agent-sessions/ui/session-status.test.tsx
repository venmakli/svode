import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSession, AgentSessionStatus } from "../model";
import {
  SessionStatusMarker,
  STATUS_OPTIONS,
  statusLabel,
  statusMarkerLabel,
  statusSourceLabel,
  statusText,
  statusTooltipDetail,
} from "./session-status";
import * as m from "@/paraglide/messages.js";

function native(
  state: DistributiveOmit<AgentSessionStatus, "source" | "confidence">,
): AgentSessionStatus {
  return {
    ...state,
    source: "native_status_reader",
    confidence: "approximate",
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "codex:session",
    source: "codex",
    sourceSessionId: "session",
    title: "Session",
    titleSource: "session-id",
    status: native({ state: "idle", stopReason: "end_turn" }),
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/repo",
    lastActivityAt: "2026-07-04T05:00:00Z",
    capabilities: {
      canResume: true,
    },
    ...overrides,
  };
}

test("status label stays normalized when a terminal is open", () => {
  const doneWithOpenTerminal = session({
    runtime: { live: true, ptyId: "pty-1" },
  });

  expect(statusLabel(doneWithOpenTerminal)).toBe(m.sessions_status_done());
  expect(statusMarkerLabel(doneWithOpenTerminal)).toBe(
    m.sessions_status_terminal_open(),
  );
  expect(statusTooltipDetail(doneWithOpenTerminal)).toBe(
    `${m.sessions_status_done()} · ${statusSourceLabel(doneWithOpenTerminal)}`,
  );
});

test("pid-only runtime without managed pty is not a terminal-open marker", () => {
  const doneWithPidOnlyRuntime = session({
    runtime: { live: true, pid: 4242 },
  });

  expect(statusLabel(doneWithPidOnlyRuntime)).toBe(m.sessions_status_done());
  expect(statusMarkerLabel(doneWithPidOnlyRuntime)).toBe(
    m.sessions_status_done(),
  );
  expect(
    renderToStaticMarkup(
      <SessionStatusMarker session={doneWithPidOnlyRuntime} />,
    ).includes(`aria-label="${m.sessions_status_done()}"`),
  ).toBe(true);
});

test("stronger status markers are not replaced by terminal-open marker", () => {
  const failedWithOpenTerminal = session({
    status: native({ state: "idle", stopReason: "error" }),
    runtime: { live: true, ptyId: "pty-1" },
  });
  const runningWithOpenTerminal = session({
    status: native({ state: "running" }),
    runtime: { live: true, ptyId: "pty-1" },
  });

  expect(statusMarkerLabel(failedWithOpenTerminal)).toBe(
    m.sessions_status_error(),
  );
  expect(statusMarkerLabel(runningWithOpenTerminal)).toBe(
    m.sessions_status_running(),
  );
});

test("one waiting value names the request kind in its qualifier", () => {
  const approval = session({
    status: native({ state: "requires_action", request: "permission" }),
  });
  const input = session({
    status: native({ state: "requires_action", request: "question" }),
  });

  expect(statusLabel(approval)).toBe(m.sessions_status_requires_action());
  expect(statusLabel(input)).toBe(m.sessions_status_requires_action());
  expect(statusText(approval)).toBe(
    `${m.sessions_status_requires_action()} — ${m.sessions_status_request_permission()}`,
  );
  expect(statusTooltipDetail(input)).toBe(
    `${m.sessions_status_request_question()} · ${m.sessions_status_source_native_status_reader()}, ${m.sessions_status_confidence_approximate()}`,
  );
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

test("idle stop reasons map onto the collection options", () => {
  const idle = (
    stopReason: Extract<AgentSessionStatus, { state: "idle" }>["stopReason"],
  ) => session({ status: native({ state: "idle", stopReason }) });

  expect(statusLabel(idle(null))).toBe(m.sessions_status_done());
  expect(statusLabel(idle("max_tokens"))).toBe(m.sessions_status_done());
  expect(statusText(idle("max_tokens"))).toBe(
    `${m.sessions_status_done()} — ${m.sessions_status_reason_max_tokens()}`,
  );
  expect(statusText(idle("end_turn"))).toBe(m.sessions_status_done());
  expect(statusLabel(idle("cancelled"))).toBe(m.sessions_status_cancelled());
  expect(statusLabel(idle("interrupted"))).toBe(
    m.sessions_status_interrupted(),
  );
  expect(statusLabel(idle("error"))).toBe(m.sessions_status_error());
});

test("unknown is never shown as done and names a missing source", () => {
  const unknown = session({
    status: { state: "unknown", source: "none", confidence: "approximate" },
  });

  expect(statusLabel(unknown)).toBe(m.sessions_status_unknown());
  expect(statusSourceLabel(unknown)).toBe(m.sessions_status_source_none());
});

test("exact managed terminal evidence is labelled with its source", () => {
  const exited = session({
    status: {
      state: "idle",
      stopReason: null,
      source: "managed_pty",
      confidence: "exact",
    },
  });

  expect(statusSourceLabel(exited)).toBe(
    `${m.sessions_status_source_managed_pty()}, ${m.sessions_status_confidence_exact()}`,
  );
});

test("every status value has a labelled marker, including done", () => {
  const markup = renderToStaticMarkup(
    <SessionStatusMarker session={session()} />,
  );
  expect(markup.includes("lucide-circle-check")).toBe(true);
  expect(markup.includes(`aria-label="${m.sessions_status_done()}"`)).toBe(
    true,
  );
  expect(STATUS_OPTIONS.map((option) => option.value)).toEqual([
    "requires_action",
    "running",
    "done",
    "cancelled",
    "interrupted",
    "error",
    "unknown",
  ]);
});

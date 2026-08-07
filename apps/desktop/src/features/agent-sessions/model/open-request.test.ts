import { expect, test } from "bun:test";

import type { AgentSession } from "./types";
import { findAgentSessionForOpenRequest } from "./open-request";

function session(
  id: string,
  launchId: string,
  provisional: boolean,
): AgentSession {
  return {
    id,
    launchId,
    source: "codex",
    sourceSessionId: id,
    title: id,
    titleSource: "session-id",
    status: "active",
    statusSource: "svode-agent-runtime",
    statusConfidence: "strong",
    runtime: { live: true, provisional },
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    lastActivityAt: "2026-08-07T10:00:00Z",
    capabilities: {
      canResume: !provisional,
      canRevealFile: !provisional,
      hasReadableLog: !provisional,
    },
    pinned: false,
    sourceMeta: {
      historyPresent: false,
      detailPresent: !provisional,
      sessionIndexPresent: false,
      detailFileCount: provisional ? 0 : 1,
      historyLineCount: 0,
      detailLineCount: provisional ? 0 : 1,
      malformedLineCount: 0,
      functionCallCount: 0,
      notes: [],
    },
  };
}

test("open request selects the provisional session immediately", () => {
  const provisional = session("codex:launch:launch-one", "launch-one", true);

  expect(
    findAgentSessionForOpenRequest([provisional], {
      launchId: "launch-one",
      requestKey: 1,
      sessionId: provisional.id,
    }),
  ).toBe(provisional);
});

test("open request prefers the canonical replacement with the same launch id", () => {
  const provisional = session("codex:launch:launch-one", "launch-one", true);
  const canonical = session("codex:source-one", "launch-one", false);

  expect(
    findAgentSessionForOpenRequest([provisional, canonical], {
      launchId: "launch-one",
      requestKey: 2,
      sessionId: provisional.id,
    }),
  ).toBe(canonical);
});

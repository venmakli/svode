import { expect, test } from "bun:test";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { sessionTimeLabel } from "./format";
import type { AgentSession } from "../model";

const now = Date.parse("2026-07-04T14:00:00Z");

function session(lastActivityAt: string): AgentSession {
  return {
    id: "codex:test",
    source: "codex",
    sourceSessionId: "test",
    title: "Test session",
    titleSource: "session-id",
    status: "done",
    activeFlags: [],
    statusSource: "fallback",
    statusConfidence: "weak",
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/repo",
    lastActivityAt,
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
  };
}

function isoBefore(ms: number): string {
  return new Date(now - ms).toISOString();
}

test("session time label stays compact for weeks, months, and years", async () => {
  const originalNow = Date.now;
  const originalLocale = getLocale();
  Date.now = () => now;

  try {
    await setLocale("en", { reload: false });

    expect(sessionTimeLabel(session(isoBefore(3 * 24 * 60 * 60_000)))).toBe(
      "3d",
    );
    expect(sessionTimeLabel(session(isoBefore(14 * 24 * 60 * 60_000)))).toBe(
      "2w",
    );
    expect(sessionTimeLabel(session(isoBefore(60 * 24 * 60 * 60_000)))).toBe(
      "2m",
    );
    expect(sessionTimeLabel(session(isoBefore(730 * 24 * 60 * 60_000)))).toBe(
      "2y",
    );
  } finally {
    Date.now = originalNow;
    await setLocale(originalLocale, { reload: false });
  }
});

test("session time label localizes compact units for Russian", async () => {
  const originalNow = Date.now;
  const originalLocale = getLocale();
  Date.now = () => now;

  try {
    await setLocale("ru", { reload: false });

    expect(sessionTimeLabel(session(isoBefore(10 * 60_000)))).toBe("10м");
    expect(sessionTimeLabel(session(isoBefore(3 * 60 * 60_000)))).toBe("3ч");
    expect(sessionTimeLabel(session(isoBefore(3 * 24 * 60 * 60_000)))).toBe(
      "3д",
    );
    expect(sessionTimeLabel(session(isoBefore(14 * 24 * 60 * 60_000)))).toBe(
      "2н",
    );
    expect(sessionTimeLabel(session(isoBefore(60 * 24 * 60 * 60_000)))).toBe(
      "2мес",
    );
    expect(sessionTimeLabel(session(isoBefore(730 * 24 * 60 * 60_000)))).toBe(
      "2г",
    );
  } finally {
    Date.now = originalNow;
    await setLocale(originalLocale, { reload: false });
  }
});

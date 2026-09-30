import { expect, test } from "bun:test";
import type { NavigationItem, NavigationKey } from "@/features/navigation";
import type { AgentSessionSourceReport, AgentSessionsListResult } from "../api";
import {
  agentSessionForNavigationKey,
  agentSessionNavigationIndex,
  agentSessionNavigationKey,
  confirmedMissingAgentSessionKeys,
  retitledAgentSessionItems,
} from "./navigation";
import { listResult, listedSession } from "./testing/catalog";

function report(
  source: AgentSessionSourceReport["source"],
  status: AgentSessionSourceReport["status"] = "ok",
): AgentSessionSourceReport {
  return {
    source,
    status,
    rootPath: `/home/${source}`,
    scannedAt: "2026-09-29T10:00:00Z",
    cacheHit: false,
    counts: {
      filesScanned: 0,
      recordsRead: 0,
      candidates: 0,
      returnedSessions: 0,
      unresolvedCandidates: 0,
      incompleteCandidates: 0,
      malformedLines: 0,
      sourceErrors: 0,
      hotFilesChecked: 0,
      hotFilesReparsed: 0,
    },
    diagnostics: [],
    truncatedDiagnostics: 0,
  };
}

function fullList(
  overrides: Partial<AgentSessionsListResult> = {},
): AgentSessionsListResult {
  return {
    ...listResult([
      listedSession({ id: "codex:kept" }),
      listedSession({ id: "claude-code:canonical", launchId: "launch-1" }),
    ]),
    sources: [report("codex"), report("claude-code")],
    ...overrides,
  };
}

const keys: NavigationKey[] = [
  { kind: "session", sessionId: "codex:kept" },
  { kind: "session", sessionId: "codex:gone" },
  { kind: "session", sessionId: "claude-code:gone" },
  { kind: "sessionLaunch", launchId: "launch-1" },
  { kind: "sessionLaunch", launchId: "launch-gone" },
  { kind: "page", path: "notes" },
];

test("a complete fresh list confirms only absent session keys", () => {
  expect(confirmedMissingAgentSessionKeys(fullList(), keys)).toEqual([
    { kind: "session", sessionId: "codex:gone" },
    { kind: "session", sessionId: "claude-code:gone" },
    { kind: "sessionLaunch", launchId: "launch-gone" },
  ]);
});

test("a partial, failed or stale read confirms nothing", () => {
  for (const result of [
    fullList({ status: "partial" }),
    fullList({ status: "error" }),
    fullList({
      cache: {
        mode: "stale-snapshot",
        hit: true,
        sourceHits: 2,
        sourceMisses: 0,
      },
    }),
  ]) {
    expect(confirmedMissingAgentSessionKeys(result, keys)).toEqual([]);
  }
});

test("an unread source keeps its sessions and every launch key", () => {
  const result = fullList({
    sources: [report("codex"), report("claude-code", "missing-root")],
  });

  expect(confirmedMissingAgentSessionKeys(result, keys)).toEqual([
    { kind: "session", sessionId: "codex:gone" },
  ]);
});

test("a provisional launch is keyed by launch id and keeps its pin after handoff", () => {
  const provisional = listedSession({
    id: "claude-code:provisional",
    launchId: "launch-1",
    runtime: { live: true, provisional: true },
  });
  const canonical = listedSession({
    id: "claude-code:canonical",
    launchId: "launch-1",
  });
  const pinned: NavigationItem[] = [
    { key: agentSessionNavigationKey(provisional), title: "Routine run" },
  ];

  expect(agentSessionNavigationKey(provisional)).toEqual({
    kind: "sessionLaunch",
    launchId: "launch-1",
  });
  expect(agentSessionNavigationKey(canonical)).toEqual({
    kind: "session",
    sessionId: "claude-code:canonical",
  });
  expect(agentSessionNavigationIndex(pinned, canonical)).toBe(0);
  expect(
    agentSessionNavigationIndex(pinned, listedSession({ id: "codex:other" })),
  ).toBe(-1);
});

test("a pinned key resolves to the catalog session, a launch key to the canonical one", () => {
  const provisional = listedSession({
    id: "claude-code:provisional",
    launchId: "launch-1",
    runtime: { live: true, provisional: true },
  });
  const canonical = listedSession({
    id: "claude-code:canonical",
    launchId: "launch-1",
  });
  const launchKey: NavigationKey = {
    kind: "sessionLaunch",
    launchId: "launch-1",
  };

  expect(agentSessionForNavigationKey(launchKey, [provisional])).toBe(
    provisional,
  );
  expect(
    agentSessionForNavigationKey(launchKey, [provisional, canonical]),
  ).toBe(canonical);
  expect(
    agentSessionForNavigationKey({ kind: "session", sessionId: "codex:gone" }, [
      canonical,
    ]),
  ).toBeNull();
});

test("a listed session with a new title refreshes its pin snapshot under the stored key", () => {
  const session = listedSession({
    id: "codex:a",
    title: "Fix login",
    launchId: "launch-a",
  });
  const pinned: NavigationItem[] = [
    { key: { kind: "sessionLaunch", launchId: "launch-a" }, title: "codex:a" },
    { key: { kind: "session", sessionId: "codex:gone" }, title: "Gone" },
  ];

  expect(retitledAgentSessionItems(pinned, [session])).toEqual([
    {
      key: { kind: "sessionLaunch", launchId: "launch-a" },
      title: "Fix login",
    },
  ]);
  expect(
    retitledAgentSessionItems(
      [{ ...pinned[0], title: "Fix login" }],
      [session],
    ),
  ).toEqual([]);
});

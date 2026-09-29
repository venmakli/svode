import type {
  AgentSession as ListedAgentSession,
  AgentSessionReentryResult,
  AgentSessionsListResult,
} from "../../api";
import type { AgentSessionCatalogApi } from "../catalog-store";

export function listedSession(
  overrides: Partial<ListedAgentSession> & Pick<ListedAgentSession, "id">,
): ListedAgentSession {
  return {
    source: "codex",
    sourceSessionId: overrides.id.replace(/^.+:/, ""),
    title: overrides.id,
    titleSource: "session-id",
    status: "done",
    activeFlags: [],
    statusSource: "fallback",
    statusConfidence: "weak",
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/project",
    lastActivityAt: "2026-09-29T10:00:00Z",
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

export function listResult(
  sessions: ListedAgentSession[],
  generatedAt = "2026-09-29T10:00:00Z",
): AgentSessionsListResult {
  return {
    generatedAt,
    projectPath: "/project",
    status: "ok",
    cache: { mode: "fingerprint-hit", hit: true, sourceHits: 1, sourceMisses: 0 },
    sessions,
    summary: {
      returnedSessions: sessions.length,
      pinnedSessions: 0,
      unresolvedCandidates: 0,
      incompleteCandidates: 0,
      malformedLines: 0,
      sourceErrors: 0,
    },
    sources: [],
  };
}

export interface FakeCatalogApi extends AgentSessionCatalogApi {
  calls: string[];
  listed: ListedAgentSession[];
  reentry: (sessionId: string) => AgentSessionReentryResult;
}

export function fakeCatalogApi(): FakeCatalogApi {
  let nextPty = 0;
  const api: FakeCatalogApi = {
    calls: [],
    listed: [],
    reentry: (sessionId) => ({
      mode: "spawned-resume-pty",
      sessionId,
      ptyId: `pty-resume-${sessionId}`,
      cwd: "/project",
    }),
    list: async (projectPath) => {
      api.calls.push(`list:${projectPath}`);
      return listResult(api.listed);
    },
    refresh: async (projectPath) => {
      api.calls.push(`refresh:${projectPath}`);
      return listResult(api.listed);
    },
    hotStatus: async (projectPath, sessionIds) => {
      api.calls.push(`hot:${sessionIds.join(",")}`);
      const sessions = api.listed.filter((session) =>
        sessionIds.includes(session.id),
      );
      return {
        generatedAt: "2026-09-29T10:00:00Z",
        projectPath,
        sessions,
        checkedSessions: sessions.length,
        updatedSessions: 0,
        skippedSessions: 0,
        sources: [],
      };
    },
    reenter: async (_projectPath, sessionId) => {
      api.calls.push(`reenter:${sessionId}`);
      return api.reentry(sessionId);
    },
    setPinned: async (_projectPath, sessionId, pinned) => {
      api.calls.push(`pin:${sessionId}:${pinned}`);
    },
    spawnTerminal: async (cwd) => {
      nextPty += 1;
      api.calls.push(`spawn:${cwd}`);
      return { ptyId: `pty-${nextPty}`, cwd };
    },
    closeTerminal: async (ptyId) => {
      api.calls.push(`close:${ptyId}`);
    },
    errorMessage: (error) => String(error),
  };
  return api;
}

export async function flushPromises() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

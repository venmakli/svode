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
    status: {
      state: "idle",
      stopReason: "end_turn",
      source: "native_status_reader",
      confidence: "approximate",
    },
    scopeKind: "project",
    scopeStatus: "ready",
    scopeConfidence: "exact",
    projectPath: "/project",
    lastActivityAt: "2026-09-29T10:00:00Z",
    capabilities: {
      canResume: true,
      canOpenInChat: false,
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
    cache: { mode: "current" },
    sessions,
    summary: {
      returnedSessions: sessions.length,
      unresolvedCandidates: 0,
      incompleteCandidates: 0,
    },
    sources: [],
  };
}

export interface FakeCatalogApi extends AgentSessionCatalogApi {
  calls: string[];
  listed: ListedAgentSession[];
  /** Live registered terminal surfaces, pty id → session id. */
  surfaces: Map<string, string>;
  reentry: (sessionId: string) => AgentSessionReentryResult;
}

/**
 * Listed sessions with the runtime of their live registered terminal, as
 * the read-model lays the terminal surfaces over them.
 */
function withSurfaces(
  sessions: ListedAgentSession[],
  surfaces: ReadonlyMap<string, string>,
): ListedAgentSession[] {
  const ptyIdBySession = new Map(
    Array.from(surfaces, ([ptyId, sessionId]) => [sessionId, ptyId]),
  );
  return sessions.map((session) => {
    const ptyId = ptyIdBySession.get(session.id);
    return ptyId ? { ...session, runtime: { ptyId, live: true } } : session;
  });
}

export function fakeCatalogApi(): FakeCatalogApi {
  let nextPty = 0;
  const api: FakeCatalogApi = {
    calls: [],
    listed: [],
    surfaces: new Map(),
    reentry: (sessionId) => {
      const ptyId = `pty-resume-${sessionId}`;
      api.surfaces.set(ptyId, sessionId);
      return { mode: "spawned-resume-pty", sessionId, ptyId, cwd: "/project" };
    },
    list: async (projectPath) => {
      api.calls.push(`list:${projectPath}`);
      return listResult(withSurfaces(api.listed, api.surfaces));
    },
    refresh: async (projectPath) => {
      api.calls.push(`refresh:${projectPath}`);
      return listResult(withSurfaces(api.listed, api.surfaces));
    },
    raiseCatalog: async () => {
      api.calls.push("raise");
    },
    hotStatus: async (projectPath, sessionIds) => {
      api.calls.push(`hot:${sessionIds.join(",")}`);
      const sessions = withSurfaces(api.listed, api.surfaces).filter(
        (session) => sessionIds.includes(session.id),
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
    spawnTerminal: async (cwd) => {
      nextPty += 1;
      api.calls.push(`spawn:${cwd}`);
      return { ptyId: `pty-${nextPty}`, cwd };
    },
    closeTerminal: async (ptyId) => {
      api.calls.push(`close:${ptyId}`);
      api.surfaces.delete(ptyId);
    },
    registerTerminal: async ({ ptyId, agentSessionId }) => {
      api.calls.push(`register:${ptyId}:${agentSessionId}`);
      api.surfaces.set(ptyId, agentSessionId);
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

import {
  DEFAULT_SPACE_GROUP_LIMIT,
  type AgentSession,
  type AgentSessionGroup,
  type AgentSessionGroupingInput,
  type AgentSessionGroupingResult,
  type AgentSessionScopeGroup,
} from "./types";

const PINNED_GROUP_ID = "pinned";
const NOW_GROUP_ID = "now";

export function buildAgentSessionGroups({
  sessions,
  spaceScopes = [],
  searchQuery = "",
  visibleLimits = {},
  selectedSessionId = null,
  selectedStableGroupId = null,
}: AgentSessionGroupingInput): AgentSessionGroupingResult {
  const filteredSessions = filterAgentSessions(sessions, searchQuery);
  const scopeIndex = createScopeIndex(spaceScopes);
  const assigned = new Set<string>();
  const visibleSessionIds = new Set<string>();
  const pinnedSessions: AgentSession[] = [];
  const nowSessions: AgentSession[] = [];
  const spaceBuckets = new Map<string, AgentSession[]>();
  const stableSpaceSession =
    selectedSessionId && isSpaceGroupId(selectedStableGroupId)
      ? filteredSessions.find(
          (session) =>
            session.id === selectedSessionId &&
            !session.pinned &&
            selectedStableGroupId === resolveScopeGroupId(session, scopeIndex),
        )
      : null;

  for (const session of filteredSessions) {
    if (!session.pinned) continue;
    pinnedSessions.push(session);
    assigned.add(session.id);
  }

  if (stableSpaceSession && !assigned.has(stableSpaceSession.id)) {
    addToSpaceBucket(spaceBuckets, stableSpaceSession, scopeIndex);
    assigned.add(stableSpaceSession.id);
  }

  for (const session of filteredSessions) {
    if (assigned.has(session.id) || !isNowSession(session)) continue;
    nowSessions.push(session);
    assigned.add(session.id);
  }

  nowSessions.sort(compareNowSessions);

  for (const session of filteredSessions) {
    if (assigned.has(session.id)) continue;
    addToSpaceBucket(spaceBuckets, session, scopeIndex);
    assigned.add(session.id);
  }

  const pinned = pinnedSessions.length
    ? group(PINNED_GROUP_ID, "pinned", pinnedSessions)
    : null;
  const now = nowSessions.length ? group(NOW_GROUP_ID, "now", nowSessions) : null;
  const knownSpaceIds = new Set(spaceScopes.map((scope) => scope.id));
  const knownSpaces = spaceScopes.map((scope) =>
    spaceGroup(scope.id, spaceBuckets.get(scope.id) ?? [], visibleLimits, scope),
  );
  const unknownSpaces = Array.from(spaceBuckets.entries())
    .filter(([id]) => !knownSpaceIds.has(id))
    .map(([id, items]) => spaceGroup(id, items, visibleLimits));
  const spaces = [...knownSpaces, ...unknownSpaces];

  const all = [
    ...(pinned ? [pinned] : []),
    ...(now ? [now] : []),
    ...spaces,
  ];
  all.forEach((item) => {
    item.sessions.forEach((session) => visibleSessionIds.add(session.id));
  });

  return { pinned, now, spaces, all, visibleSessionIds };
}

export function filterAgentSessions(
  sessions: AgentSession[],
  searchQuery: string,
): AgentSession[] {
  const needle = searchQuery.trim().toLowerCase();
  if (!needle) return sessions;

  return sessions.filter((session) =>
    searchableMetadata(session).some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

export function isNowSession(session: AgentSession): boolean {
  return (
    session.status === "active" ||
    session.runtime?.live === true ||
    hasActionableWait(session)
  );
}

export function hasActionableWait(session: AgentSession): boolean {
  return session.status === "active" && Boolean(session.activeFlags?.length);
}

export function scopeGroupId(session: AgentSession): string {
  return sessionDefaultScopeGroupId(session);
}

export function projectScopeGroupId(projectPath: string | undefined): string {
  return `space:project:${projectPath ?? "root"}`;
}

export function childSpaceScopeGroupId(
  spaceIdOrPath: string | undefined,
): string {
  return `space:${spaceIdOrPath ?? "unknown"}`;
}

function sessionDefaultScopeGroupId(session: AgentSession): string {
  if (session.scopeKind === "space") {
    return childSpaceScopeGroupId(session.spaceId ?? session.spacePath);
  }

  return projectScopeGroupId(session.projectPath);
}

export function isSpaceGroupId(groupId: string | null | undefined): boolean {
  return Boolean(groupId?.startsWith("space:"));
}

function addToSpaceBucket(
  buckets: Map<string, AgentSession[]>,
  session: AgentSession,
  scopeIndex: ScopeIndex,
): void {
  const id = resolveScopeGroupId(session, scopeIndex);
  const current = buckets.get(id) ?? [];
  current.push(session);
  buckets.set(id, current);
}

function resolveScopeGroupId(
  session: AgentSession,
  scopeIndex: ScopeIndex,
): string {
  if (session.scopeKind === "project") {
    if (session.projectPath) {
      const scope = scopeIndex.byPath.get(session.projectPath);
      if (scope) return scope.id;
    }
    return scopeIndex.project?.id ?? sessionDefaultScopeGroupId(session);
  }

  if (session.spaceId) {
    const scope = scopeIndex.byScopeId.get(session.spaceId);
    if (scope) return scope.id;
  }
  if (session.spacePath) {
    const scope = scopeIndex.byPath.get(session.spacePath);
    if (scope) return scope.id;
  }
  return sessionDefaultScopeGroupId(session);
}

function group(
  id: string,
  kind: AgentSessionGroup["kind"],
  sessions: AgentSession[],
  scope?: AgentSessionScopeGroup,
): AgentSessionGroup {
  const result: AgentSessionGroup = {
    id,
    kind,
    sessions,
    total: sessions.length,
  };
  if (scope) {
    result.scope = scope;
  }
  return result;
}

function spaceGroup(
  id: string,
  items: AgentSession[],
  visibleLimits: Record<string, number>,
  scope?: AgentSessionScopeGroup,
): AgentSessionGroup {
  const visibleLimit = visibleLimits[id] ?? DEFAULT_SPACE_GROUP_LIMIT;
  const visibleSessions = items.slice(0, visibleLimit);
  return {
    ...group(id, "space", visibleSessions, scope),
    total: items.length,
    visibleLimit,
    hasMore: items.length > visibleLimit,
  };
}

interface ScopeIndex {
  project: AgentSessionScopeGroup | null;
  byScopeId: Map<string, AgentSessionScopeGroup>;
  byPath: Map<string, AgentSessionScopeGroup>;
}

function createScopeIndex(scopes: AgentSessionScopeGroup[]): ScopeIndex {
  const byScopeId = new Map<string, AgentSessionScopeGroup>();
  const byPath = new Map<string, AgentSessionScopeGroup>();
  let project: AgentSessionScopeGroup | null = null;

  scopes.forEach((scope) => {
    byScopeId.set(scope.scopeId, scope);
    byPath.set(scope.path, scope);
    if (scope.kind === "project") {
      project = scope;
    }
  });

  return { project, byScopeId, byPath };
}

function compareNowSessions(
  left: AgentSession,
  right: AgentSession,
): number {
  const priorityDelta = nowPriority(right) - nowPriority(left);
  if (priorityDelta !== 0) return priorityDelta;

  return timestampMs(right.lastActivityAt) - timestampMs(left.lastActivityAt);
}

function nowPriority(session: AgentSession): number {
  if (hasActionableWait(session)) return 3;
  if (session.status === "active") return 2;
  if (session.runtime?.live) return 1;
  return 0;
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function searchableMetadata(session: AgentSession): string[] {
  return [
    session.title,
    session.source,
    session.id,
    session.sourceSessionId,
    session.status,
    session.statusReason,
    session.statusSource,
    session.scopeKind,
    session.scopeStatus,
    session.scopeConfidence,
    session.projectId,
    session.projectPath,
    session.spaceId,
    session.spacePath,
    session.cwd,
    session.startedAt,
    session.lastActivityAt,
    session.waitingSince,
  ].filter((value): value is string => Boolean(value));
}

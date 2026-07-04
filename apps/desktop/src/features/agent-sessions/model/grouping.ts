import {
  DEFAULT_SPACE_GROUP_LIMIT,
  type AgentSession,
  type AgentSessionGroup,
  type AgentSessionGroupingInput,
  type AgentSessionGroupingResult,
} from "./types";

const PINNED_GROUP_ID = "pinned";
const NOW_GROUP_ID = "now";

export function buildAgentSessionGroups({
  sessions,
  searchQuery = "",
  visibleLimits = {},
  selectedSessionId = null,
  selectedStableGroupId = null,
}: AgentSessionGroupingInput): AgentSessionGroupingResult {
  const filteredSessions = filterAgentSessions(sessions, searchQuery);
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
            selectedStableGroupId === scopeGroupId(session),
        )
      : null;

  for (const session of filteredSessions) {
    if (!session.pinned) continue;
    pinnedSessions.push(session);
    assigned.add(session.id);
  }

  if (stableSpaceSession && !assigned.has(stableSpaceSession.id)) {
    addToSpaceBucket(spaceBuckets, stableSpaceSession);
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
    addToSpaceBucket(spaceBuckets, session);
    assigned.add(session.id);
  }

  const pinned = pinnedSessions.length
    ? group(PINNED_GROUP_ID, "pinned", pinnedSessions)
    : null;
  const now = nowSessions.length ? group(NOW_GROUP_ID, "now", nowSessions) : null;
  const spaces = Array.from(spaceBuckets.entries()).map(([id, items]) => {
    const visibleLimit = visibleLimits[id] ?? DEFAULT_SPACE_GROUP_LIMIT;
    const visibleSessions = items.slice(0, visibleLimit);
    return {
      ...group(id, "space", visibleSessions),
      total: items.length,
      visibleLimit,
      hasMore: items.length > visibleLimit,
    };
  });

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
  if (session.scopeKind === "space") {
    return `space:${session.spaceId ?? session.spacePath ?? "unknown"}`;
  }

  return `space:project:${session.projectPath ?? "root"}`;
}

export function isSpaceGroupId(groupId: string | null | undefined): boolean {
  return Boolean(groupId?.startsWith("space:"));
}

function addToSpaceBucket(
  buckets: Map<string, AgentSession[]>,
  session: AgentSession,
): void {
  const id = scopeGroupId(session);
  const current = buckets.get(id) ?? [];
  current.push(session);
  buckets.set(id, current);
}

function group(
  id: string,
  kind: AgentSessionGroup["kind"],
  sessions: AgentSession[],
): AgentSessionGroup {
  return {
    id,
    kind,
    sessions,
    total: sessions.length,
  };
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

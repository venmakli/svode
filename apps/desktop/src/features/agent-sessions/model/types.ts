import type {
  AgentSession as BackendAgentSession,
  AgentSessionSource as BackendAgentSessionSource,
  AgentSessionStatus,
} from "../api";

export type AgentSessionSource = BackendAgentSessionSource | "unknown";
export type AgentSession = Omit<BackendAgentSession, "source"> & {
  source: AgentSessionSource;
};
export type { AgentSessionStatus };

export const DEFAULT_SPACE_GROUP_LIMIT = 10;

export type AgentSessionGroupKind = "pinned" | "now" | "space";
export type AgentSessionScopeGroupKind = "project" | "space";
export type AgentSessionScopeGroupStatus = "ready" | "missing" | "broken";

export interface AgentSessionScopeGroup {
  id: string;
  kind: AgentSessionScopeGroupKind;
  scopeId: string;
  name: string;
  icon: string | null;
  path: string;
  status: AgentSessionScopeGroupStatus;
}

export interface AgentSessionGroup {
  id: string;
  kind: AgentSessionGroupKind;
  sessions: AgentSession[];
  total: number;
  visibleLimit?: number;
  hasMore?: boolean;
  scope?: AgentSessionScopeGroup;
}

export interface AgentSessionGroupingInput {
  sessions: AgentSession[];
  spaceScopes?: AgentSessionScopeGroup[];
  searchQuery?: string;
  visibleLimits?: Record<string, number>;
  selectedSessionId?: string | null;
  selectedStableGroupId?: string | null;
}

export interface AgentSessionGroupingResult {
  pinned: AgentSessionGroup | null;
  now: AgentSessionGroup | null;
  spaces: AgentSessionGroup[];
  all: AgentSessionGroup[];
  visibleSessionIds: Set<string>;
}

export type AgentSessionSelectionSource = "pinned" | "now" | "space";

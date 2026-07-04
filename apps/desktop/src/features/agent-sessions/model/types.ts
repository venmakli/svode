import type {
  AgentSession,
  AgentSessionSource,
  AgentSessionStatus,
} from "../api";

export type { AgentSession, AgentSessionSource, AgentSessionStatus };

export const DEFAULT_SPACE_GROUP_LIMIT = 10;

export type AgentSessionGroupKind = "pinned" | "now" | "space";

export interface AgentSessionGroup {
  id: string;
  kind: AgentSessionGroupKind;
  sessions: AgentSession[];
  total: number;
  visibleLimit?: number;
  hasMore?: boolean;
}

export interface AgentSessionGroupingInput {
  sessions: AgentSession[];
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

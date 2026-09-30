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

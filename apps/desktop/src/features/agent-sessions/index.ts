export {
  requestAgentSessionCatalogFastRefresh,
  useActiveAgentSessions,
  useAgentSessionCatalogLifecycle,
  useAgentSessionSpace,
  useListedAgentSessions,
  useResolvedAgentSession,
  useSessionTerminals,
  useStartAgentSession,
  type AgentSessionSpace,
  type SessionTerminals,
} from "./hooks";
export {
  AgentSessionBreadcrumbs,
  AgentSessionMainSurface,
  AgentSessionNavigationItem,
  AgentSessionPeek,
  CloseSessionTerminalsDialog,
  NewSessionSidebarItem,
  AgentSessionsSurface,
} from "./ui";
export { isInsideAgentSessionContent } from "./lib";
export {
  agentSessionForNavigationKey,
  agentSessionNavigationIndex,
  agentSessionNavigationKey,
  agentSessionTargetFor,
  pinnableAgentSessionItem,
} from "./model";
export type {
  AgentSession,
  AgentSessionOpenOptions,
  AgentSessionScopeGroup,
  AgentSessionTarget,
  NewSessionSpaceRef,
} from "./model";

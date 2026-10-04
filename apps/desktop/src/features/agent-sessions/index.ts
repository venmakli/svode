export {
  requestAgentSessionCatalogFastRefresh,
  useActiveAgentSessions,
  useAgentSessionCatalogLifecycle,
  useAgentSessionSpace,
  useListedAgentSessions,
  useResolvedAgentSession,
  useSessionTerminals,
  useOpenNewSession,
  useStartAgentSession,
  type AgentSessionSpace,
  type NewSessionOpening,
  type SessionTerminals,
} from "./hooks";
export {
  AgentSessionBreadcrumbs,
  AgentSessionDraftMainSurface,
  AgentSessionMainSurface,
  AgentSessionNavigationItem,
  AgentSessionPeek,
  CloseSessionTerminalsDialog,
  NewSessionSidebarItem,
  AgentSessionsSurface,
} from "./ui";
export { isInsideAgentSessionContent } from "./lib";
export type { StartedSession as NewSessionStarted } from "./chat/hooks/use-new-session-draft";
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
  NewSessionDraftTarget,
  NewSessionSpaceRef,
} from "./model";
export {
  AttachmentOpenerContext as ChatAttachmentOpenerContext,
  type OpenAttachment as OpenChatAttachment,
} from "./chat/hooks/use-attachment-opener";
export {
  attachmentKind as chatAttachmentKind,
  locateAttachment as locateChatAttachment,
  type Attachment as ChatAttachment,
  type AttachmentLocation as ChatAttachmentLocation,
} from "./chat/model/attachments";

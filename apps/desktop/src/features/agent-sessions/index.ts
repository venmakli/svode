export {
  requestAgentSessionCatalogFastRefresh,
  useActiveAgentSessions,
  useAgentSessionCatalogLifecycle,
  useAgentSessionSpace,
  useListedAgentSessions,
  useResolvedAgentSession,
  useSavedProjectSessions,
  useSessionTerminals,
  useOpenNewSession,
  useStartAgentSession,
  type AgentSessionSpace,
  type NewSessionOpening,
  type SavedProjectSessions,
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
  agentSessionHasId,
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
  DraftSpaceChoice,
  DraftSpaceChoices,
  NewSessionSpaceRef,
} from "./model";
export {
  AttachmentOpenerContext as ChatAttachmentOpenerContext,
  type OpenAttachment as OpenChatAttachment,
} from "./chat/hooks/use-attachment-opener";
export {
  ChangesOpenerContext as ChatChangesOpenerContext,
  type FileChangesTarget as ChatFileChangesTarget,
} from "./chat/hooks/use-changes-opener";
export {
  attachmentKind as chatAttachmentKind,
  locateAttachment as locateChatAttachment,
  type Attachment as ChatAttachment,
  type AttachmentLocation as ChatAttachmentLocation,
} from "./chat/model/attachments";

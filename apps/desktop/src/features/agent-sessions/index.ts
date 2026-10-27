export {
  requestAgentSessionCatalogFastRefresh,
  subscribeAgentSessionTerminalFollow,
  useActiveAgentSessions,
  useAgentSessionCatalogLifecycle,
  useAgentSessionChangesTarget,
  useAgentSessionSpace,
  useListedAgentSessions,
  useResolvedAgentSession,
  useSavedProjectSessions,
  useNewSessionTarget,
  useOpenNewSession,
  type AgentSessionSpace,
  type NewSessionOpening,
  type SavedProjectSessions,
} from "./hooks";
export {
  AgentSessionDraftMainSurface,
  AgentSessionMainSurface,
  AgentSessionNavigationItem,
  AgentSessionPeek,
  NewSessionSidebarItem,
  AgentSessionsSurface,
} from "./ui";
export { isInsideAgentSessionContent } from "./lib";
export type { StartedSession as NewSessionStarted } from "./chat/hooks/use-new-session-draft";
export { useDictatedDrafts } from "./chat/hooks/use-dictated-drafts";
export {
  agentSessionForNavigationKey,
  agentSessionHasId,
  agentSessionNavigationIndex,
  agentSessionNavigationKey,
  agentSessionTargetFor,
  isAgentTurnActive,
  pinnableAgentSessionItem,
  requiresUserAction,
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
  requestComposerFocus,
  type ComposerFocusRequest,
} from "./chat/hooks/use-composer-focus";
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

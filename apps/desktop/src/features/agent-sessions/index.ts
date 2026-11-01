export {
  requestAgentSessionCatalogFastRefresh,
  subscribeAgentSessionTerminalFollow,
  useActiveAgentSessions,
  useAgentSessionCatalogLifecycle,
  useAgentSessionChangesTarget,
  useAgentSessionSpace,
  useAgentSessionsReadProject,
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
// Announcements without a started session (Stage 11 `03`): the one seam of a
// draft session for a new session draft, an Actor binding and the device's
// default agent; the agents' last declarations are part of the popover's
// host seam in `agent-settings-popover`.
export {
  useDraftAgent,
  type DraftAgentState,
} from "./chat/hooks/use-draft-agent";
export { useSessionActivity as useAgentSessionActivity } from "./chat/hooks/use-session-activity";
export { useSessionSettings as useAgentSessionSettings } from "./chat/hooks/use-session-settings";
export {
  canOpenChatSession,
  putNewSessionRequest,
  putSessionRequest,
} from "./chat/hooks/composer-request";
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
export { chatMediaFile } from "./chat/api/media";
export {
  HeldMediaOpenerContext as ChatHeldMediaOpenerContext,
  type OpenHeldMedia as OpenChatHeldMedia,
} from "./chat/hooks/use-media-opener";
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

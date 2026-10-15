export { AttachmentsSurface } from "./ui/attachments-surface";
export { AttachmentsFolderTable } from "./ui/attachments-folder-table";
export type { AttachmentsFolder } from "./hooks/use-attachments-folder-source";
export { attachmentOwnerFromScopeOwner } from "./model/types";
export {
  ATTACHMENTS_PRESENTATION_ID,
  attachmentKindLabel,
  attachmentsPresentationState,
  createAttachmentsPresentationDescriptor,
} from "./model/presentation";
export type {
  AttachmentActivationRequest,
  AttachmentAvailability,
  AttachmentKind,
  AttachmentOwnerRef,
  AttachmentOwnerPeekContext,
  AttachmentOwnerPeekRenderer,
  AttachmentRow,
  AttachmentsSnapshot,
  AttachmentsSourceState,
  ResolvedAttachmentOwner,
} from "./model/types";

export { AttachmentsPeek } from "./ui/attachments-peek";

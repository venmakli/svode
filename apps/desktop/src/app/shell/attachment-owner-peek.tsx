import type { AttachmentOwnerPeekContext } from "@/features/attachments";
import { CompactScopePeek } from "./compact-scope-peek";

export function AttachmentOwnerPeek({
  target,
  spaceId,
  onExpand,
  onClose,
  registerCloseGuard,
  onContentPathChange,
  dismiss,
}: AttachmentOwnerPeekContext) {
  const { item } = target;
  return (
    <CompactScopePeek
      path={item.contentPath ?? item.path}
      spaceId={spaceId}
      spacePath={target.owner.spacePath}
      projectPath={target.owner.projectPath}
      sessionKey={target.ownerSession?.key ?? item.key}
      fallbackTitle={item.displayName}
      fallbackIcon={item.icon}
      onExpand={onExpand}
      onClose={onClose}
      registerNavigationGuard={registerCloseGuard}
      onContentPathChange={onContentPathChange}
      dismiss={dismiss}
    />
  );
}

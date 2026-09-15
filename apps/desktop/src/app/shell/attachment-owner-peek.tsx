import type { AttachmentOwnerPeekContext } from "@/features/attachments";
import { CompactScopePeek } from "./compact-scope-peek";

export function AttachmentOwnerPeek({
  target,
  spaceId,
  renderActions,
  registerCloseGuard,
  onContentPathChange,
}: AttachmentOwnerPeekContext) {
  const { row } = target;
  return (
    <CompactScopePeek
      path={row.contentPath ?? row.path}
      directory={!row.contentPath && row.kind !== "page"}
      spaceId={spaceId}
      spacePath={target.owner.spacePath}
      projectPath={target.owner.projectPath}
      sessionKey={target.ownerSession?.key ?? row.key}
      fallbackTitle={row.displayName}
      fallbackIcon={row.icon}
      renderActions={renderActions}
      registerNavigationGuard={registerCloseGuard}
      onContentPathChange={onContentPathChange}
    />
  );
}

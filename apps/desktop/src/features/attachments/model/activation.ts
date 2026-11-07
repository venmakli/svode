import type {
  AttachmentActivationRequest,
  AttachmentItem,
  AttachmentsSnapshot,
} from "./types";
import { sameRuntimePath } from "./types";

export function currentAttachmentItem(
  snapshot: AttachmentsSnapshot,
  item: AttachmentItem,
) {
  return snapshot.items.find(
    (candidate) =>
      candidate.key === item.key &&
      candidate.path === item.path &&
      candidate.kind === item.kind,
  );
}

export function reconcileAttachmentPeek(
  current: AttachmentActivationRequest | null,
  snapshot: AttachmentsSnapshot,
): AttachmentActivationRequest | null {
  if (
    !current ||
    !sameRuntimePath(current.owner.spacePath, snapshot.owner.spacePath) ||
    !sameRuntimePath(current.owner.projectPath, snapshot.owner.projectPath) ||
    current.owner.ownerPath !== snapshot.owner.ownerPath
  )
    return null;
  const item =
    currentAttachmentItem(snapshot, current.item) ??
    snapshot.items.find(
      (candidate) =>
        current.ownerSession &&
        current.item.ownerPath &&
        candidate.ownerPath === current.item.ownerPath &&
        candidate.sourceShape === "directory" &&
        ["page", "collection", "app"].includes(candidate.kind),
    );
  if (item?.kind === "app" && !item.hasApp) return null;
  if (item) return { ...current, item, sourceGeneration: snapshot.generation };
  // A file viewer owns its not-found state, so a missing file keeps the peek.
  return current.item.kind === "document" || current.item.kind === "media"
    ? current
    : null;
}

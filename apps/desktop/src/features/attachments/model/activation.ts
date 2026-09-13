import type {
  AttachmentActivationRequest,
  AttachmentRow,
  AttachmentsSnapshot,
} from "./types";
import { sameRuntimePath } from "./types";

export function currentAttachmentRow(
  snapshot: AttachmentsSnapshot,
  row: AttachmentRow,
) {
  return snapshot.rows.find(
    (candidate) =>
      candidate.key === row.key &&
      candidate.path === row.path &&
      candidate.kind === row.kind,
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
  const row =
    currentAttachmentRow(snapshot, current.row) ??
    snapshot.rows.find(
      (candidate) =>
        current.ownerSession &&
        !current.row.contentPath &&
        candidate.contentPath &&
        current.row.ownerPath &&
        candidate.ownerPath === current.row.ownerPath &&
        candidate.sourceShape === "directory" &&
        (current.row.kind === "collection"
          ? candidate.kind === "collection"
          : current.row.kind === "app" &&
            candidate.kind === "page" &&
            candidate.hasApp),
    );
  if (current.ownerSession?.kind === "app" && !row?.hasApp) return null;
  return row
    ? { ...current, row, sourceGeneration: snapshot.generation }
    : null;
}

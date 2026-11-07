import type {
  AttachmentActivationRequest,
  AttachmentItem,
  AttachmentsSnapshot,
} from "./types";
import { sameRuntimePath } from "./types";
import type { AttachmentBranch } from "./source-session";

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

/** The next step of a request to open the folder at `path` in its peek. */
export type AttachmentOpenFolderStep =
  | { kind: "open"; item: AttachmentItem }
  | { kind: "load"; branchPath: string }
  | { kind: "wait" }
  | { kind: "missing" };

/**
 * Finds the folder among the read items, reading the branches of its
 * ancestors one by one; only an ordinary folder opens.
 */
export function attachmentOpenFolderStep(
  inventory: AttachmentsSnapshot,
  branches: ReadonlyMap<string, AttachmentBranch>,
  path: string,
): AttachmentOpenFolderStep {
  const directories = inventory.items.filter(
    (item) => item.ownerPath && item.sourceShape === "directory",
  );
  const exact = directories.find((item) => item.ownerPath === path);
  if (exact)
    return exact.kind === "directory"
      ? { kind: "open", item: exact }
      : { kind: "missing" };
  const ancestor = directories
    .filter((item) => path.startsWith(`${item.ownerPath}/`))
    .sort((left, right) => right.ownerPath!.length - left.ownerPath!.length)[0];
  if (!ancestor) return { kind: "missing" };
  const branch = branches.get(ancestor.ownerPath!);
  if (!branch) return { kind: "load", branchPath: ancestor.ownerPath! };
  return branch.loading ? { kind: "wait" } : { kind: "missing" };
}

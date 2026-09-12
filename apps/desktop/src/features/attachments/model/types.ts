import type { CollectionActivationContext } from "@/features/collection";
import {
  supportsScopeAttachments,
  type ScopeOwnerRef,
} from "@/features/scope-surfaces";

export type AttachmentKind =
  | "page"
  | "collection"
  | "app"
  | "document"
  | "media";
export type AttachmentAvailability = "available" | "limited" | "external_only";

export interface AttachmentRow {
  key: string;
  path: string;
  sourceShape: "file" | "directory";
  contentPath: string | null;
  ownerPath: string | null;
  sourcePath: string;
  hasApp: boolean;
  icon: string | null;
  kind: AttachmentKind;
  format: string;
  availability: AttachmentAvailability;
  displayName: string;
  modified: string;
  sizeBytes: number | null;
}

export interface AttachmentsSnapshot {
  owner: ResolvedAttachmentOwner;
  generation: string;
  rows: AttachmentRow[];
  diagnostics: Array<{ code: string; path: string }>;
}

export interface ResolvedAttachmentOwner {
  projectPath: string;
  spaceId: string | null;
  spacePath: string;
  ownerPath: string;
  repositoryPath: string;
}

export interface AttachmentOwnerRef {
  ownerKey: string;
  identityKind: "registered-space" | "page-directory";
  projectPath: string;
  spaceId: string;
  spacePath: string;
  ownerPath: string;
  contentPath: string;
  hasDirectCollection: boolean;
}

export interface AttachmentActivationRequest {
  row: AttachmentRow;
  owner: ResolvedAttachmentOwner;
  mode: "peek";
  sourceGeneration: string;
  activation: CollectionActivationContext;
}

export type AttachmentsSourceState =
  | { phase: "initial" }
  | { phase: "blocking_error"; message: string }
  | {
      phase: "ready";
      snapshot: AttachmentsSnapshot;
      refreshError: string | null;
    };

export interface AttachmentOwnerInput {
  projectPath: string;
  spaceId: string | null;
  ownerPath: string;
}

export function attachmentOwnerInput(
  owner: AttachmentOwnerRef,
): AttachmentOwnerInput {
  return {
    projectPath: owner.projectPath,
    spaceId: owner.projectPath === owner.spacePath ? null : owner.spaceId,
    ownerPath: owner.ownerPath,
  };
}

export function attachmentOwnerFromScopeOwner(
  owner: ScopeOwnerRef,
): AttachmentOwnerRef {
  if (!supportsScopeAttachments(owner)) {
    throw new Error(
      "Attachments requires a registered Project/Space or folder Page owner",
    );
  }
  return {
    contentPath: owner.readmePath,
    hasDirectCollection: owner.capabilities.includes("collection"),
    identityKind:
      owner.identityKind === "registered-space"
        ? "registered-space"
        : "page-directory",
    ownerKey: owner.ownerKey,
    ownerPath: owner.ownerPath,
    projectPath: owner.projectPath,
    spaceId: owner.spaceId,
    spacePath: owner.spacePath,
  };
}

export function attachmentOwnerGenerationKey(
  owner: AttachmentOwnerRef,
): string {
  const input = attachmentOwnerInput(owner);
  return `${normalizeRuntimePath(input.projectPath)}\0${input.spaceId ?? "root"}\0${input.ownerPath}`;
}

export function sameRuntimePath(left: string, right: string): boolean {
  return normalizeRuntimePath(left) === normalizeRuntimePath(right);
}

function normalizeRuntimePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

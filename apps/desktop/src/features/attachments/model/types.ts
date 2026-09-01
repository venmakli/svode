import type { CollectionActivationContext } from "@/features/collection";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

export type AttachmentKind = "page" | "document" | "media";
export type AttachmentAvailability = "available" | "limited" | "external_only";

export interface AttachmentRow {
  key: string;
  path: string;
  sourceShape: "file" | "directory";
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
  ownerPath: ".";
  repositoryPath: string;
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
}

export function attachmentOwnerInput(
  owner: ScopeOwnerRef,
): AttachmentOwnerInput {
  if (owner.identityKind !== "registered-space" || owner.ownerPath !== ".") {
    throw new Error("Attachments 5A requires a registered Project/Space owner");
  }
  return {
    projectPath: owner.projectPath,
    spaceId: owner.projectPath === owner.spacePath ? null : owner.spaceId,
  };
}

export function attachmentOwnerGenerationKey(owner: ScopeOwnerRef): string {
  const input = attachmentOwnerInput(owner);
  return `${normalizeRuntimePath(input.projectPath)}\0${input.spaceId ?? "root"}`;
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

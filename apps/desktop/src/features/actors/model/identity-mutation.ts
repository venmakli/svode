import type { ActorCatalogSnapshot, ActorCatalogRow } from "./types";

export type ActorMutationIntent =
  | { kind: "add" }
  | { kind: "merge"; source: ActorCatalogRow }
  | { kind: "edit"; source: ActorCatalogRow };

export type ActorMutationAction =
  | {
      kind: "add";
      displayName: string;
      canonicalEmail: string;
    }
  | {
      kind: "merge";
      sourceCanonicalEmail: string;
      targetCanonicalEmail: string;
    }
  | {
      kind: "edit";
      sourceCanonicalEmail: string;
      displayName: string;
      canonicalEmail: string;
    };

export type ActorMutationBlockReason =
  | "access_checking"
  | "access_read_only"
  | "access_unknown"
  | "invalid_mailmap"
  | "unsafe_mailmap"
  | "invalid_name"
  | "invalid_email"
  | "actor_not_found"
  | "same_merge_target"
  | "no_merge_target"
  | "stale_preview"
  | "current_identity_changed";

export interface ActorMutationReview {
  action: ActorMutationAction;
  repositoryId: string;
  previewFingerprint: string;
  resultDisplayName: string;
  resultCanonicalEmail: string;
  transferredAliasEmails: readonly string[];
  affectsCurrentIdentity: boolean;
  currentIdentityFingerprint: string | null;
}

export type ActorMutationPreviewResult =
  | { status: "ready"; review: ActorMutationReview }
  | { status: "duplicate"; canonicalEmail: string }
  | {
      status: "blocked";
      reason: ActorMutationBlockReason;
      message: string;
    };

export type ActorMutationApplyResult =
  | {
      status: "applied";
      canonicalEmail: string;
      catalog: ActorCatalogSnapshot;
    }
  | { status: "duplicate"; canonicalEmail: string }
  | {
      status: "blocked";
      reason: ActorMutationBlockReason;
      message: string;
    };

export interface ActorMutationFailure {
  reason: ActorMutationBlockReason | "unexpected";
  message: string;
}

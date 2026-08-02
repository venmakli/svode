import type { ActorMutationBlockReason } from "./identity-mutation";

export interface ActorMailmapSaveReview {
  repositoryId: string;
  fingerprint: string;
}

export type ActorMailmapSaveReviewResult =
  | { status: "clean" }
  | {
      status: "ready";
      review: ActorMailmapSaveReview;
      requiresConsent: boolean;
    }
  | { status: "deferred_submodule" }
  | {
      status: "blocked";
      reason: ActorMutationBlockReason;
      message: string;
    };

export type ActorMailmapSaveResult =
  | { status: "committed" }
  | { status: "clean" }
  | { status: "stale" }
  | { status: "deferred_submodule" }
  | { status: "failed"; message: string }
  | {
      status: "blocked";
      reason: ActorMutationBlockReason;
      message: string;
    };

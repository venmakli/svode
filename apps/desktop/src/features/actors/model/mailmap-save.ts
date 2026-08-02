import type {
  ActorMutationBlockReason,
  ActorRepositoryPersistenceOutcome,
} from "./identity-mutation";

export interface ActorMailmapSaveReview {
  repositoryId: string;
  fingerprint: string;
  rootPointerFingerprint?: string;
}

export type ActorMailmapSaveReviewResult =
  | { status: "clean" }
  | {
      status: "ready";
      review: ActorMailmapSaveReview;
      requiresConsent: boolean;
    }
  | {
      status: "blocked";
      reason: ActorMutationBlockReason;
      message: string;
    };

export type ActorMailmapSaveResult =
  | {
      status: "saved";
      persistence: ActorRepositoryPersistenceOutcome;
    }
  | { status: "stale" }
  | {
      status: "blocked";
      reason: ActorMutationBlockReason;
      message: string;
    };

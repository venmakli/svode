import { invokeCommand } from "@/platform/native/invoke";

export type ActorContributionDto = "contributor" | "no_commits";
export type ActorSourceKindDto = "history" | "current_git_identity" | "mailmap";
export type ActorDiagnosticKindDto =
  | "invalid_line"
  | "unsafe_file"
  | "custom_source";

export interface ActorAliasDto {
  name?: string | null;
  email: string;
  line?: number | null;
}

export interface ActorSourceDto {
  kind: ActorSourceKindDto;
  name: string;
  email: string;
  line?: number | null;
}

export interface ActorCatalogRowDto {
  canonicalEmail: string;
  displayName: string;
  contribution: ActorContributionDto;
  commitCount: number;
  lastCommitAt: number | null;
  lastActivityDate: string | null;
  aliases: ActorAliasDto[];
  sources: ActorSourceDto[];
}

export interface ActorDiagnosticDto {
  kind: ActorDiagnosticKindDto;
  line?: number | null;
  message: string;
  blocking: boolean;
}

export interface ActorCatalogDto {
  repositoryId: string;
  generation: number;
  rows: ActorCatalogRowDto[];
  diagnostics: ActorDiagnosticDto[];
  shallow: boolean;
}

export interface ActorActivityDayDto {
  date: string;
  commitCount: number;
}

export interface ActorActivityDto {
  repositoryId: string;
  generation: number;
  canonicalEmail: string;
  rangeStart: string;
  rangeEndExclusive: string;
  days: ActorActivityDayDto[];
}

export type ActorMutationActionDto =
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

export type ActorMutationBlockReasonDto =
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

export interface ActorMutationReviewDto {
  action: ActorMutationActionDto;
  repositoryId: string;
  previewFingerprint: string;
  resultDisplayName: string;
  resultCanonicalEmail: string;
  transferredAliasEmails: string[];
  affectsCurrentIdentity: boolean;
  currentIdentityFingerprint?: string | null;
}

export type ActorCommitExpectationDto = "automatic_if_safe" | "manual";

export type ActorExactPathPendingReasonDto =
  | "policy_off"
  | "target_dirty"
  | "index_staged"
  | "target_changed"
  | "index_interference";

export type ActorExactPathPersistenceOutcomeDto =
  | { status: "committed" }
  | { status: "pending"; reason: ActorExactPathPendingReasonDto }
  | { status: "failed"; message: string }
  | { status: "clean" };

export interface ActorRepositoryPersistenceOutcomeDto {
  mailmap: ActorExactPathPersistenceOutcomeDto;
  rootPointer?: ActorExactPathPersistenceOutcomeDto;
}

export type ActorMutationPreviewResultDto =
  | {
      status: "ready";
      review: ActorMutationReviewDto;
      commitExpectation: ActorCommitExpectationDto;
      rootPointerCommitExpectation?: ActorCommitExpectationDto;
    }
  | { status: "duplicate"; canonicalEmail: string }
  | {
      status: "blocked";
      reason: ActorMutationBlockReasonDto;
      message: string;
    };

export type ActorMutationApplyResultDto =
  | {
      status: "applied";
      canonicalEmail: string;
      catalog: ActorCatalogDto;
      currentIdentityUpdated: boolean;
      persistence: ActorRepositoryPersistenceOutcomeDto;
    }
  | { status: "duplicate"; canonicalEmail: string }
  | {
      status: "blocked";
      reason: ActorMutationBlockReasonDto;
      message: string;
    };

export interface ActorMailmapSaveReviewDto {
  repositoryId: string;
  fingerprint: string;
  rootPointerFingerprint?: string;
}

export type ActorMailmapSaveReviewResultDto =
  | { status: "clean" }
  | {
      status: "ready";
      review: ActorMailmapSaveReviewDto;
      requiresConsent: boolean;
    }
  | {
      status: "blocked";
      reason: ActorMutationBlockReasonDto;
      message: string;
    };

export type ActorMailmapSaveResultDto =
  | {
      status: "saved";
      persistence: ActorRepositoryPersistenceOutcomeDto;
    }
  | { status: "stale" }
  | {
      status: "blocked";
      reason: ActorMutationBlockReasonDto;
      message: string;
    };

export function getActorsCatalog(spacePath: string) {
  return invokeCommand<ActorCatalogDto>("actors_get_catalog", { spacePath });
}

export function refreshActorsCatalog(spacePath: string) {
  return invokeCommand<ActorCatalogDto>("actors_refresh_catalog", {
    spacePath,
  });
}

export function getActorActivity(spacePath: string, canonicalEmail: string) {
  return invokeCommand<ActorActivityDto>("actors_get_activity", {
    canonicalEmail,
    spacePath,
  });
}

export function previewActorMutation(
  projectPath: string,
  spacePath: string,
  action: ActorMutationActionDto,
) {
  return invokeCommand<ActorMutationPreviewResultDto>(
    "actors_preview_mutation",
    { action, projectPath, spacePath },
  );
}

export function applyActorMutation(
  projectPath: string,
  spacePath: string,
  review: ActorMutationReviewDto,
) {
  return invokeCommand<ActorMutationApplyResultDto>("actors_apply_mutation", {
    projectPath,
    review,
    spacePath,
  });
}

export function getActorMailmapSaveReview(
  projectPath: string,
  spacePath: string,
) {
  return invokeCommand<ActorMailmapSaveReviewResultDto>(
    "actors_get_mailmap_save_review",
    { projectPath, spacePath },
  );
}

export function saveActorMailmap(
  projectPath: string,
  spacePath: string,
  review: ActorMailmapSaveReviewDto,
) {
  return invokeCommand<ActorMailmapSaveResultDto>("actors_save_mailmap", {
    projectPath,
    review,
    spacePath,
  });
}

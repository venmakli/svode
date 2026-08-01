import {
  applyActorMutation as applyActorMutationCommand,
  getActorActivity,
  getActorsCatalog,
  previewActorMutation as previewActorMutationCommand,
  refreshActorsCatalog,
  type ActorActivityDto,
  type ActorCatalogDto,
  type ActorMutationReviewDto,
} from "@/platform/actors/actors-api";

import type {
  ActorActivitySnapshot,
  ActorCatalogSnapshot,
} from "../model/types";
import type {
  ActorMutationAction,
  ActorMutationApplyResult,
  ActorMutationPreviewResult,
  ActorMutationReview,
} from "../model/identity-mutation";

export async function loadActorCatalog(
  spacePath: string,
): Promise<ActorCatalogSnapshot> {
  return toActorCatalog(await getActorsCatalog(spacePath));
}

export async function refreshActorCatalog(
  spacePath: string,
): Promise<ActorCatalogSnapshot> {
  return toActorCatalog(await refreshActorsCatalog(spacePath));
}

export async function loadActorActivity(
  spacePath: string,
  canonicalEmail: string,
): Promise<ActorActivitySnapshot> {
  return toActorActivity(await getActorActivity(spacePath, canonicalEmail));
}

export async function previewActorMutation(
  spacePath: string,
  action: ActorMutationAction,
): Promise<ActorMutationPreviewResult> {
  const result = await previewActorMutationCommand(spacePath, action);
  if (result.status !== "ready") return result;
  return {
    status: "ready",
    review: toActorMutationReview(result.review),
  };
}

export async function applyActorMutation(
  spacePath: string,
  review: ActorMutationReview,
): Promise<ActorMutationApplyResult> {
  const result = await applyActorMutationCommand(spacePath, {
    ...review,
    transferredAliasEmails: [...review.transferredAliasEmails],
  });
  if (result.status !== "applied") return result;
  return {
    status: "applied",
    canonicalEmail: result.canonicalEmail,
    catalog: toActorCatalog(result.catalog),
  };
}

function toActorCatalog(dto: ActorCatalogDto): ActorCatalogSnapshot {
  return Object.freeze({
    repositoryId: dto.repositoryId,
    generation: dto.generation,
    rows: Object.freeze(
      dto.rows.map((row) =>
        Object.freeze({
          ...row,
          aliases: Object.freeze(
            row.aliases.map((alias) =>
              Object.freeze({
                email: alias.email,
                line: alias.line ?? null,
                name: alias.name ?? null,
              }),
            ),
          ),
          sources: Object.freeze(
            row.sources.map((source) =>
              Object.freeze({
                ...source,
                line: source.line ?? null,
              }),
            ),
          ),
        }),
      ),
    ),
    diagnostics: Object.freeze(
      dto.diagnostics.map((diagnostic) =>
        Object.freeze({
          ...diagnostic,
          line: diagnostic.line ?? null,
        }),
      ),
    ),
    shallow: dto.shallow,
  });
}

function toActorActivity(dto: ActorActivityDto): ActorActivitySnapshot {
  return Object.freeze({
    ...dto,
    days: Object.freeze(dto.days.map((day) => Object.freeze({ ...day }))),
  });
}

function toActorMutationReview(
  review: ActorMutationReviewDto,
): ActorMutationReview {
  return Object.freeze({
    ...review,
    currentIdentityFingerprint: review.currentIdentityFingerprint ?? null,
    transferredAliasEmails: Object.freeze([...review.transferredAliasEmails]),
  });
}

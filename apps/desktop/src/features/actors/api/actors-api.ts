import {
  getActorActivity,
  getActorsCatalog,
  refreshActorsCatalog,
  type ActorActivityDto,
  type ActorCatalogDto,
} from "@/platform/actors/actors-api";

import type {
  ActorActivitySnapshot,
  ActorCatalogSnapshot,
} from "../model/types";

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

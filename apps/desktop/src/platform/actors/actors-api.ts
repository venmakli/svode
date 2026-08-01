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

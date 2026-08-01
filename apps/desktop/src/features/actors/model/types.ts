export type ActorContribution = "contributor" | "no_commits";
export type ActorSourceKind = "history" | "current_git_identity" | "mailmap";
export type ActorDiagnosticKind =
  | "invalid_line"
  | "unsafe_file"
  | "custom_source";

export interface ActorAlias {
  name: string | null;
  email: string;
  line: number | null;
}

export interface ActorSource {
  kind: ActorSourceKind;
  name: string;
  email: string;
  line: number | null;
}

export interface ActorCatalogRow {
  canonicalEmail: string;
  displayName: string;
  contribution: ActorContribution;
  commitCount: number;
  lastCommitAt: number | null;
  lastActivityDate: string | null;
  aliases: readonly ActorAlias[];
  sources: readonly ActorSource[];
}

export interface ActorDiagnostic {
  kind: ActorDiagnosticKind;
  line: number | null;
  message: string;
  blocking: boolean;
}

export interface ActorCatalogSnapshot {
  repositoryId: string;
  generation: number;
  rows: readonly ActorCatalogRow[];
  diagnostics: readonly ActorDiagnostic[];
  shallow: boolean;
}

export interface ActorActivityDay {
  date: string;
  commitCount: number;
}

export interface ActorActivitySnapshot {
  repositoryId: string;
  generation: number;
  canonicalEmail: string;
  rangeStart: string;
  rangeEndExclusive: string;
  days: readonly ActorActivityDay[];
}

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
  availableYears: readonly number[];
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

export interface ActorActivityCommit {
  subject: string;
  authoredAt: number;
  localDate: string;
  localTime: string;
  shortSha: string;
}

export interface ActorActivityMonth {
  month: string;
  commitCount: number;
  commits: readonly ActorActivityCommit[];
}

export interface ActorActivityTimeline {
  day: string | null;
  months: readonly ActorActivityMonth[];
  nextCursor: string | null;
}

export interface ActorActivitySnapshot {
  repositoryId: string;
  generation: number;
  canonicalEmail: string;
  availableYears: readonly number[];
  selectedYear: number;
  rangeStart: string;
  rangeEndExclusive: string;
  commitCount: number;
  days: readonly ActorActivityDay[];
  timeline: ActorActivityTimeline;
}

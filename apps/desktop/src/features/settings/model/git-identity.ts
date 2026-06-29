import type {
  FanoutPreviewEntry,
  GitIdentity,
  RepoIdentityResult,
} from "@/features/identity";

export type IdentitySummarySource =
  | "global"
  | "project"
  | "repository"
  | "partial"
  | "missing";

export interface IdentityDraft {
  name: string;
  email: string;
}

export interface IdentitySummary {
  identity: GitIdentity | null;
  source: IdentitySummarySource;
  hasRepoOverride: boolean;
  text: string | null;
  initials: string;
}

export function identityText(identity: GitIdentity | null): string | null {
  if (!identity) return null;
  return `${identity.name} <${identity.email}>`;
}

export function identityInitials(identity: GitIdentity | null): string {
  const source = identity?.name || identity?.email || "";
  const first = source.trim().charAt(0);
  return first ? first.toLocaleUpperCase() : "?";
}

export function repoIdentityHasOverride(
  result: RepoIdentityResult | null,
): boolean {
  return Boolean(
    result?.local ||
    result?.localName ||
    result?.localEmail ||
    result?.source === "partial",
  );
}

export function identityDraftFromRepoIdentity(
  result: RepoIdentityResult | null,
): IdentityDraft {
  return {
    name: result?.local?.name ?? result?.localName ?? "",
    email: result?.local?.email ?? result?.localEmail ?? "",
  };
}

export function identitySummary(
  result: RepoIdentityResult | null,
  isRoot: boolean,
): IdentitySummary {
  const hasRepoOverride = repoIdentityHasOverride(result);
  const identity = result?.effective ?? null;
  const source = identitySummarySource(result, isRoot);

  return {
    identity,
    source,
    hasRepoOverride,
    text: identityText(identity),
    initials: identityInitials(identity),
  };
}

export function identitySummarySource(
  result: RepoIdentityResult | null,
  isRoot: boolean,
): IdentitySummarySource {
  if (!result || !result.effective || result.source === "missing") {
    return "missing";
  }
  if (result.source === "partial") {
    return "partial";
  }
  if (result.source === "local") {
    return isRoot ? "project" : "repository";
  }
  return "global";
}

export function fanoutEntrySummarySource(
  entry: FanoutPreviewEntry,
): IdentitySummarySource {
  if (entry.source === "partial") return "partial";
  if (entry.source === "local" || entry.currentLocal) return "repository";
  if (entry.source === "missing") return "missing";
  if (entry.currentEffective) return "global";
  return "missing";
}

export function fanoutEntryHasOverride(entry: FanoutPreviewEntry): boolean {
  return Boolean(
    entry.willReplace ||
    entry.currentLocal ||
    entry.source === "local" ||
    entry.source === "partial",
  );
}

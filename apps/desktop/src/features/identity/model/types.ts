export interface GitIdentity {
  name: string;
  email: string;
}

export type GitIdentityFieldSource = "local" | "global" | "missing";
export type RepoIdentitySource = "local" | "global" | "missing" | "partial";

export interface IdentityFieldSources {
  name: GitIdentityFieldSource;
  email: GitIdentityFieldSource;
}

/**
 * Why the global identity could not be read: Git itself is missing or too old
 * (answered by the Git dialog), or its config could not be read.
 */
export type IdentityLoadErrorKind = "git_unavailable" | "unreadable";

export interface IdentityLoadError {
  kind: IdentityLoadErrorKind;
  message: string;
}

export interface GlobalIdentityResult {
  global: GitIdentity | null;
  source: "global" | "missing";
  fingerprint: string;
}

export type GlobalIdentityMutationStatus =
  | "updated"
  | "unchanged"
  | "conflict";

export interface GlobalIdentityMutationResult {
  status: GlobalIdentityMutationStatus;
  canonical: GlobalIdentityResult;
}

export interface RepoIdentityResult {
  local: GitIdentity | null;
  localName?: string | null;
  localEmail?: string | null;
  effective: GitIdentity | null;
  fieldSources?: IdentityFieldSources;
  source: RepoIdentitySource;
}

export interface FanoutPreviewEntry {
  spacePath: string;
  spaceName: string;
  currentLocal: GitIdentity | null;
  currentEffective?: GitIdentity | null;
  source?: RepoIdentitySource;
  fieldSources?: IdentityFieldSources;
  willReplace: boolean;
}

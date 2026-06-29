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

export interface GlobalIdentityResult {
  global: GitIdentity | null;
  source: "global" | "missing";
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

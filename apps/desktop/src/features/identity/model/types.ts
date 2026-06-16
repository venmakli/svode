export interface GitIdentity {
  name: string;
  email: string;
}

export interface GlobalIdentityResult {
  global: GitIdentity | null;
  source: "global" | "missing";
}

export interface RepoIdentityResult {
  local: GitIdentity | null;
  effective: GitIdentity | null;
  source: "local" | "global" | "missing";
}

export interface FanoutPreviewEntry {
  spacePath: string;
  spaceName: string;
  currentLocal: GitIdentity | null;
  willReplace: boolean;
}

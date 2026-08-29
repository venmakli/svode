export type RepositoryAccessStatus =
  | "local"
  | "checking"
  | "writable"
  | "read_only"
  | "unknown";

export type RepositoryAccessReason =
  | "not_checked"
  | "auth_required"
  | "offline_or_timeout"
  | "unsupported_ref"
  | "unsupported_remote_configuration"
  | "ambiguous_rejection"
  | "lease_conflict"
  | "expired"
  | "remote_changed";

export type RepositoryAccessPrimaryAction =
  | "none"
  | "verify"
  | "authenticate"
  | "edit_remote"
  | "recommendations";

export interface RepositoryAccessSnapshot {
  repositoryId: string;
  generation: number;
  status: RepositoryAccessStatus;
  reason: RepositoryAccessReason | null;
  checkedAt: number | null;
  expiresAt: number | null;
  lastKnownStatus: RepositoryAccessStatus | null;
}

export interface RepositoryAccessDenial {
  kind: "repository_access_denied";
  repositoryId: string;
  status: RepositoryAccessStatus;
  reason: RepositoryAccessReason | "mutation_plan_changed" | "none";
}

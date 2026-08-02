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

export interface RepositoryAccessSnapshot {
  repositoryId: string;
  generation: number;
  status: RepositoryAccessStatus;
  reason: RepositoryAccessReason | null;
  checkedAt: number | null;
  expiresAt: number | null;
  lastKnownStatus: RepositoryAccessStatus | null;
}

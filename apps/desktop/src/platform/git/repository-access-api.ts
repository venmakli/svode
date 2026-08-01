import { invokeCommand } from "@/platform/native/invoke";

export type RepositoryAccessStatusDto =
  | "local"
  | "checking"
  | "writable"
  | "read_only"
  | "unknown";

export type RepositoryAccessReasonDto =
  | "not_checked"
  | "auth_required"
  | "offline_or_timeout"
  | "unsupported_ref"
  | "unsupported_remote_configuration"
  | "ambiguous_rejection"
  | "lease_conflict"
  | "expired"
  | "remote_changed";

export interface RepositoryAccessSnapshotDto {
  repositoryId: string;
  generation: number;
  status: RepositoryAccessStatusDto;
  reason?: RepositoryAccessReasonDto;
  checkedAt?: number;
  expiresAt?: number;
  lastKnownStatus?: RepositoryAccessStatusDto;
}

export function getRepositoryAccess(
  spacePath: string,
): Promise<RepositoryAccessSnapshotDto> {
  return invokeCommand<RepositoryAccessSnapshotDto>("repository_access_get", {
    spacePath,
  });
}

export function verifyRepositoryAccess(
  spacePath: string,
): Promise<RepositoryAccessSnapshotDto> {
  return invokeCommand<RepositoryAccessSnapshotDto>(
    "repository_access_verify",
    { spacePath },
  );
}

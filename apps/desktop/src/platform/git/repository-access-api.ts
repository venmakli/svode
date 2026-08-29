import { invokeCommand } from "@/platform/native/invoke";
import {
  listen,
  type EventCallback,
  type UnlistenFn,
} from "@/platform/native/events";

const REPOSITORY_ACCESS_CHANGED_EVENT = "git:repository-access-changed";

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

export interface RepositoryAccessChangedEventDto {
  repositoryId: string;
}

export type RepositoryAccessDeniedReasonDto =
  | RepositoryAccessReasonDto
  | "mutation_plan_changed"
  | "none";

export interface RepositoryAccessDeniedDto {
  kind: "repository_access_denied";
  repositoryId: string;
  status: RepositoryAccessStatusDto;
  reason: RepositoryAccessDeniedReasonDto;
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

export function listenRepositoryAccessChanged(
  handler: EventCallback<RepositoryAccessChangedEventDto>,
): Promise<UnlistenFn> {
  return listen<RepositoryAccessChangedEventDto>(
    REPOSITORY_ACCESS_CHANGED_EVENT,
    handler,
  );
}

export function toRepositoryAccessDeniedDto(
  error: unknown,
): RepositoryAccessDeniedDto | null {
  const candidate = unwrapCause(error);
  if (!isRecord(candidate)) return null;
  if (candidate.kind !== "repository_access_denied") return null;
  if (typeof candidate.repositoryId !== "string") return null;
  if (!isRepositoryAccessStatus(candidate.status)) return null;
  if (!isRepositoryAccessDeniedReason(candidate.reason)) return null;
  return {
    kind: "repository_access_denied",
    repositoryId: candidate.repositoryId,
    status: candidate.status,
    reason: candidate.reason,
  };
}

function unwrapCause(error: unknown): unknown {
  if (isRecord(error) && "cause" in error && error.cause != null) {
    return error.cause;
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRepositoryAccessStatus(
  value: unknown,
): value is RepositoryAccessStatusDto {
  return (
    value === "local" ||
    value === "checking" ||
    value === "writable" ||
    value === "read_only" ||
    value === "unknown"
  );
}

function isRepositoryAccessDeniedReason(
  value: unknown,
): value is RepositoryAccessDeniedReasonDto {
  return (
    value === "not_checked" ||
    value === "auth_required" ||
    value === "offline_or_timeout" ||
    value === "unsupported_ref" ||
    value === "unsupported_remote_configuration" ||
    value === "ambiguous_rejection" ||
    value === "lease_conflict" ||
    value === "expired" ||
    value === "remote_changed" ||
    value === "mutation_plan_changed" ||
    value === "none"
  );
}

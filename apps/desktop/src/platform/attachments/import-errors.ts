/** Why the Git LFS route of a managed import is not ready on this device. */
export type LfsNotReadyReasonDto =
  | "strategy_mismatch"
  | "s3_address_missing"
  | "s3_not_connected"
  | "secret"
  | "s3_check_failed"
  | "lfs_tooling_unavailable"
  | "remote_unreachable"
  | "remote_offline";

/** A managed import refused because its Git LFS route is not ready. */
export interface LfsNotReadyErrorDto {
  kind: "lfs_not_ready";
  reason: LfsNotReadyReasonDto;
  /** Stable code of the refusal, such as `S3_NOT_CONNECTED`. */
  code: string | null;
  /** English text of the backend, for a reason this build does not know. */
  message: string;
  /** Storage strategy of a `strategy_mismatch`. */
  strategy?: string;
  /** Name of the unreadable Secret of a `secret` reason; never its value. */
  secret?: string;
}

const REASONS = new Set<string>([
  "strategy_mismatch",
  "s3_address_missing",
  "s3_not_connected",
  "secret",
  "s3_check_failed",
  "lfs_tooling_unavailable",
  "remote_unreachable",
  "remote_offline",
]);

export function toLfsNotReadyErrorDto(
  error: unknown,
): LfsNotReadyErrorDto | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("kind" in error) ||
    error.kind !== "lfs_not_ready" ||
    !("reason" in error) ||
    typeof error.reason !== "string" ||
    !REASONS.has(error.reason)
  )
    return null;
  const fields = error as Record<string, unknown>;
  return {
    kind: "lfs_not_ready",
    reason: error.reason as LfsNotReadyReasonDto,
    code: typeof fields.code === "string" ? fields.code : null,
    message: typeof fields.message === "string" ? fields.message : "",
    strategy: typeof fields.strategy === "string" ? fields.strategy : undefined,
    secret: typeof fields.secret === "string" ? fields.secret : undefined,
  };
}

import {
  toLfsNotReadyErrorDto,
  type LfsNotReadyErrorDto,
} from "@/platform/attachments/import-errors";
import { getNativeErrorMessage } from "@/platform/native/errors";
import * as m from "@/paraglide/messages.js";

const STRATEGIES_OF_THIS_VERSION = new Set([
  "local",
  "in-git",
  "lfs-remote",
  "lfs-s3",
]);

function lfsNotReadyReason(refusal: LfsNotReadyErrorDto): string {
  switch (refusal.reason) {
    case "strategy_mismatch":
      return refusal.strategy &&
        !STRATEGIES_OF_THIS_VERSION.has(refusal.strategy)
        ? m.attachments_import_lfs_strategy_newer({
            strategy: refusal.strategy,
          })
        : m.attachments_import_lfs_strategy_without_lfs();
    case "s3_address_missing":
      return m.attachments_import_lfs_s3_address_missing();
    case "s3_not_connected":
      return m.attachments_import_lfs_s3_not_connected();
    case "secret": {
      const name = refusal.secret ?? "";
      return refusal.code === "SECRET_NOT_FOUND"
        ? m.attachments_import_lfs_secret_missing({ name })
        : m.attachments_import_lfs_secret_unreadable({ name });
    }
    case "s3_check_failed":
      return m.attachments_import_lfs_s3_check_failed();
    case "lfs_tooling_unavailable":
      return m.attachments_import_lfs_tooling_unavailable();
    case "remote_unreachable":
    case "remote_offline":
      return m.attachments_import_lfs_remote_unreachable();
  }
}

/**
 * Text of a refused managed import: "File not added: <reason>", with a Git
 * LFS route reason in the interface language and any other refusal as the
 * backend names it.
 */
export function attachmentImportRefusalMessage(error: unknown): string {
  const refusal = toLfsNotReadyErrorDto(error);
  return m.attachments_import_failed({
    reason: refusal ? lfsNotReadyReason(refusal) : getNativeErrorMessage(error),
  });
}

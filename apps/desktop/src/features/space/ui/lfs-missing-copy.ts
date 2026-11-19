import * as m from "@/paraglide/messages.js";
import { transferMegabytes } from "@/features/git";
import type { LfsDownloadStop, LfsMissing } from "../model";

const MEBIBYTE = 1024 * 1024;
const SMALLEST_SHOWN = MEBIBYTE / 10;

/** Megabytes of LFS content; a file below 0.05 MB reads "< 0.1 MB", not "0 MB". */
export function lfsMegabytes(bytes: number): string {
  const size =
    bytes > 0 && bytes < SMALLEST_SHOWN / 2
      ? `< ${transferMegabytes(SMALLEST_SHOWN)}`
      : transferMegabytes(bytes);
  return m.storage_lfs_missing_size({ size });
}

/** "3 files not downloaded · 120 MB". */
export function lfsMissingSummary(missing: LfsMissing): string {
  return [
    m.storage_lfs_missing_files({ count: missing.files.length }),
    lfsMegabytes(missing.bytes),
  ].join(" · ");
}

/** Why the last download stopped; `other` carries the git-lfs text. */
export function lfsDownloadStopReason(stop: LfsDownloadStop): string {
  switch (stop.kind) {
    case "no-access":
      return m.storage_lfs_stop_no_access();
    case "unreachable":
      return m.storage_lfs_stop_unreachable();
    case "stalled":
      return m.storage_lfs_stop_stalled();
    case "not-on-server":
      return m.storage_lfs_stop_not_on_server();
    case "other":
      return stop.detail.trim();
  }
}

/** "3 files not downloaded · 120 MB. The server is unreachable." */
export function lfsMissingDescription(missing: LfsMissing): string {
  const reason = lfsDownloadStopReason(missing.stop);
  const summary = `${lfsMissingSummary(missing)}.`;
  if (!reason) return summary;
  return `${summary} ${/[.!?…]$/u.test(reason) ? reason : `${reason}.`}`;
}

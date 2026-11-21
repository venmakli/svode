import * as m from "@/paraglide/messages.js";
import { transferMegabytes } from "../lib/transfer-size";
import type { GitLfsUnsent } from "../model";

const MEBIBYTE = 1024 * 1024;
const SMALLEST_SHOWN = MEBIBYTE / 10;

type LfsSendStop = GitLfsUnsent["stop"];

/** Megabytes of LFS content; a file below 0.05 MB reads "< 0.1 MB", not "0 MB". */
export function lfsMegabytes(bytes: number): string {
  const size =
    bytes > 0 && bytes < SMALLEST_SHOWN / 2
      ? `< ${transferMegabytes(SMALLEST_SHOWN)}`
      : transferMegabytes(bytes);
  return m.storage_lfs_missing_size({ size });
}

/** "2 files not sent · 40 MB". */
function lfsUnsentSummary(unsent: GitLfsUnsent): string {
  return [
    m.storage_lfs_unsent_files({ count: unsent.files.length }),
    lfsMegabytes(unsent.bytes),
  ].join(" · ");
}

/** Why the last send failed; `other` carries the git-lfs text. */
function lfsSendStopReason(stop: LfsSendStop): string {
  switch (stop.kind) {
    case "unreachable":
      return m.storage_lfs_send_stop_unreachable();
    case "no-access":
      return m.storage_lfs_send_stop_no_access();
    case "stalled":
      return stop.path
        ? m.storage_lfs_send_stop_stalled_file({
            name: stop.path.split("/").pop() || stop.path,
            size: lfsMegabytes(stop.size ?? 0),
          })
        : m.storage_lfs_send_stop_stalled();
    case "not-on-device":
      return m.storage_lfs_send_stop_not_on_device();
    case "other":
      return stop.detail.trim();
  }
}

function withoutEndPunctuation(text: string): string {
  return text.replace(/[.!?…]+$/u, "");
}

/** "2 files not sent · 40 MB. The file server is unreachable." */
export function lfsUnsentDescription(unsent: GitLfsUnsent): string {
  const summary = `${lfsUnsentSummary(unsent)}.`;
  const reason = lfsSendStopReason(unsent.stop);
  if (!reason) return summary;
  return `${summary} ${/[.!?…]$/u.test(reason) ? reason : `${reason}.`}`;
}

/**
 * The hint of the LFS place: "2 files not sent · 40 MB. The file server is
 * unreachable — changes are published, the files will be sent with the next
 * sync."
 */
export function lfsUnsentHint(unsent: GitLfsUnsent): string {
  const reason = withoutEndPunctuation(lfsSendStopReason(unsent.stop));
  const outcome =
    unsent.stop.kind === "no-access"
      ? m.storage_lfs_unsent_outcome_kept()
      : m.storage_lfs_unsent_outcome_next_sync();
  const summary = `${lfsUnsentSummary(unsent)}.`;
  return reason
    ? `${summary} ${reason} — ${outcome}`
    : `${summary} ${outcome.charAt(0).toLocaleUpperCase()}${outcome.slice(1)}`;
}

/**
 * The warning of a sync that published changes without their LFS content:
 * "Changes are published, but 2 files are not sent: the file server is
 * unreachable. They will be sent with the next sync."
 */
export function lfsUnsentWarning(unsent: GitLfsUnsent): string {
  const reason = withoutEndPunctuation(lfsSendStopReason(unsent.stop));
  return m.storage_lfs_unsent_sync_warning({
    count: unsent.files.length,
    // A sentence of Svode goes on in lower case; the git-lfs text stays.
    reason:
      unsent.stop.kind === "other"
        ? reason
        : `${reason.charAt(0).toLocaleLowerCase()}${reason.slice(1)}`,
  });
}

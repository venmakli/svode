import * as m from "@/paraglide/messages.js";
import { transferMegabytes } from "../lib/transfer-size";
import type { GitTransfer } from "../model";

/**
 * "Uploading 1 of 2 · video.mov · 12 of 95 MB": the file name without its
 * folders, and no file count or size while they are unknown.
 */
export function gitTransferLabel(transfer: GitTransfer): string {
  const upload = transfer.direction === "upload";
  const counted = transfer.files > 0 && transfer.file > 0;
  const action = counted
    ? (upload ? m.git_transfer_upload_files : m.git_transfer_download_files)({
        file: String(transfer.file),
        files: String(transfer.files),
      })
    : upload
      ? m.git_transfer_upload()
      : m.git_transfer_download();
  const name = transfer.path.split("/").pop() || transfer.path;
  const bytes =
    transfer.size > 0
      ? m.git_transfer_bytes({
          bytes: transferMegabytes(Math.min(transfer.bytes, transfer.size)),
          size: transferMegabytes(transfer.size),
        })
      : null;
  return [action, name, bytes].filter(Boolean).join(" · ");
}

/** The share of the current file transferred, or `null` while its size is unknown. */
export function gitTransferPercent(transfer: GitTransfer): number | null {
  if (transfer.size <= 0) return null;
  return Math.min(100, (transfer.bytes / transfer.size) * 100);
}

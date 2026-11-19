import { listenGitTransfer } from "@/platform/git/git-api";
import type {
  GitTransferEventDto,
  GitTransferProgressDto,
} from "@/platform/git/git-types";
import { useGitStore, type GitTransfer } from "../model";

/** A transfer shorter than this shows nothing. */
export const TRANSFER_SHOWN_AFTER_MS = 2000;

function toGitTransfer(progress: GitTransferProgressDto): GitTransfer {
  return {
    direction: progress.direction,
    file: progress.file,
    files: progress.files,
    path: progress.path,
    bytes: progress.bytes,
    size: progress.size,
  };
}

/**
 * Records the transfers of each repository into the transfer store once one
 * lasted `shownAfterMs` since its first report, until its end.
 */
export function createGitTransferRecorder(
  shownAfterMs = TRANSFER_SHOWN_AFTER_MS,
) {
  const shown = new Set<string>();
  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; latest: GitTransfer }
  >();
  const setTransfer = (repository: string, transfer: GitTransfer | null) =>
    useGitStore.getState().setTransfer(repository, transfer);

  return {
    record({ repository, progress }: GitTransferEventDto) {
      if (!progress) {
        const waiting = pending.get(repository);
        if (waiting) clearTimeout(waiting.timer);
        pending.delete(repository);
        if (shown.delete(repository)) setTransfer(repository, null);
        return;
      }
      const transfer = toGitTransfer(progress);
      if (shown.has(repository)) {
        setTransfer(repository, transfer);
        return;
      }
      const waiting = pending.get(repository);
      if (waiting) {
        waiting.latest = transfer;
        return;
      }
      const timer = setTimeout(() => {
        const due = pending.get(repository);
        pending.delete(repository);
        if (!due) return;
        shown.add(repository);
        setTransfer(repository, due.latest);
      }, shownAfterMs);
      pending.set(repository, { timer, latest: transfer });
    },
    dispose() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const repository of shown) setTransfer(repository, null);
      shown.clear();
    },
  };
}

export async function listenGitTransfers(): Promise<() => void> {
  const recorder = createGitTransferRecorder();
  const unlisten = await listenGitTransfer(recorder.record);
  return () => {
    unlisten();
    recorder.dispose();
  };
}

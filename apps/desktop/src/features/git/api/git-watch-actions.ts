import { listenGitCommitted } from "@/platform/git/git-api";
import { listenSpaceDirty } from "@/platform/space/space-api";

interface GitWatchEvent<T> {
  payload: T;
}

type GitWatchEventHandler<T> = (event: GitWatchEvent<T>) => void;
type GitWatchUnlistenFn = () => void;

interface GitWatchDirtyEvent {
  space: string;
}

interface GitWatchCommittedEvent {
  spacePath: string;
}

export function listenGitWatchDirty(
  handler: GitWatchEventHandler<GitWatchDirtyEvent>,
): Promise<GitWatchUnlistenFn> {
  return listenSpaceDirty((event) =>
    handler({ payload: { space: event.payload.space } }),
  );
}

export function listenGitWatchCommitted(
  handler: GitWatchEventHandler<GitWatchCommittedEvent>,
): Promise<GitWatchUnlistenFn> {
  return listenGitCommitted((event) =>
    handler({ payload: { spacePath: event.payload.spacePath } }),
  );
}

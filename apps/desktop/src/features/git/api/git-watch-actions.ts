import { listenGitCommitted } from "@/platform/git/git-api";
import { listenSpaceDirty } from "@/platform/space/space-api";

type GitWatchUnlistenFn = () => void;
type GitWatchSpaceHandler = (spacePath: string) => void;

export function listenGitWatchDirty(
  handler: GitWatchSpaceHandler,
): Promise<GitWatchUnlistenFn> {
  return listenSpaceDirty((event) => handler(event.payload.space));
}

export function listenGitWatchCommitted(
  handler: GitWatchSpaceHandler,
): Promise<GitWatchUnlistenFn> {
  return listenGitCommitted((event) => handler(event.payload.spacePath));
}

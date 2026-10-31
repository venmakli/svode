import {
  getGitLastSynced,
  getGitRemote,
  getGitUserPolicy,
  getUnpushedCommits,
  listenGitCommitted,
} from "@/platform/git/git-api";
import { useGitStore } from "../model";
import type { UnpushedCommitDto } from "@/platform/git/git-types";
import type { GitSyncOutcome, GitUnpushedCommit } from "../model";
import {
  saveGitRemoteCredentials,
  type SaveGitRemoteCredentialsInput,
  syncSpace,
} from "./git-actions";
import { refreshGitRemoteStatus } from "./git-status-actions";

type GitSyncCommitHandler = (spacePath: string) => void;
type GitSyncUnlistenFn = () => void;

export interface GitSyncWidgetConfig {
  hasRemote: boolean;
  autoSync: boolean;
}

function toGitUnpushedCommit(commit: UnpushedCommitDto): GitUnpushedCommit {
  return {
    sha: commit.sha,
    message: commit.message,
    author: commit.author,
    timestamp: commit.timestamp,
  };
}

export async function getGitSyncWidgetConfig(
  spacePath: string,
  projectPath?: string | null,
): Promise<GitSyncWidgetConfig> {
  const policy = await getGitUserPolicy({ spacePath, projectPath });
  const remote = await getGitRemote(spacePath);
  return {
    hasRemote: !!remote && remote.trim().length > 0,
    autoSync: policy.autoSync === true,
  };
}

export function getGitOutgoingCommits(
  spacePath: string,
): Promise<GitUnpushedCommit[]> {
  return getUnpushedCommits(spacePath).then((commits) =>
    commits.map(toGitUnpushedCommit),
  );
}

export function refreshGitSyncRemoteStatus(spacePath: string) {
  return refreshGitRemoteStatus(spacePath);
}

export function syncGitNow(spacePath: string): Promise<GitSyncOutcome> {
  return syncSpace(spacePath);
}

export function saveGitSyncCredentials(
  input: SaveGitRemoteCredentialsInput,
): Promise<void> {
  return saveGitRemoteCredentials(input);
}

/** Read when the repository last synced on this device into the store. */
export async function getGitLastSyncedAt(spacePath: string): Promise<void> {
  const at = await getGitLastSynced(spacePath);
  // A sync that finished meanwhile is newer than the stored time.
  const git = useGitStore.getState();
  const repository = git.statuses[spacePath]?.repository ?? spacePath;
  if (at != null && (git.lastSynced[repository] ?? 0) < at)
    git.setLastSynced(spacePath, at);
}

export function listenGitSyncCommits(
  handler: GitSyncCommitHandler,
): Promise<GitSyncUnlistenFn> {
  return listenGitCommitted((event) => handler(event.payload.spacePath));
}

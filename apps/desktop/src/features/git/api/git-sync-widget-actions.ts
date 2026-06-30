import {
  getGitRemote,
  getGitUserPolicy,
  getUnpushedCommits,
  listenGitCommitted,
  setGitAutoSync as setPlatformGitAutoSync,
} from "@/platform/git/git-api";
import type { UnpushedCommitDto } from "@/platform/git/git-types";
import type { GitSyncOutcome, GitUnpushedCommit } from "../model";
import { syncSpace } from "./git-actions";
import { refreshGitRemoteStatus } from "./git-status-actions";

type GitSyncCommitHandler = (spacePath: string) => void;
type GitSyncUnlistenFn = () => void;

export interface GitSyncWidgetConfig {
  hasRemote: boolean;
  autoSync: boolean;
}

export interface SetGitAutoSyncInput {
  spacePath: string;
  projectPath?: string | null;
  enabled: boolean;
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

export async function setGitAutoSync({
  spacePath,
  projectPath,
  enabled,
}: SetGitAutoSyncInput): Promise<void> {
  await setPlatformGitAutoSync({
    spacePath,
    projectPath,
    enabled,
  });
}

export function listenGitSyncCommits(
  handler: GitSyncCommitHandler,
): Promise<GitSyncUnlistenFn> {
  return listenGitCommitted((event) => handler(event.payload.spacePath));
}

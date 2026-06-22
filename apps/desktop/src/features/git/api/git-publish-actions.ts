import {
  enableGitAutoSync,
  getGitRemote,
  getUnpushedCommits,
  listenGitCommitted,
  publishGit,
} from "@/platform/git/git-api";
import { getSpaceConfig } from "@/platform/space/space-api";
import { useGitStore } from "../model";
import type { UnpushedCommitDto } from "@/platform/git/git-types";
import type { GitUnpushedCommit } from "../model";

type GitPublishCommitHandler = (spacePath: string) => void;
type GitPublishUnlistenFn = () => void;

export interface GitPublishPromptState {
  visible: boolean;
  commits: GitUnpushedCommit[];
}

export interface PublishGitCommitsInput {
  spacePath: string;
  projectPath?: string | null;
  enableAutoSync: boolean;
}

function toGitUnpushedCommit(commit: UnpushedCommitDto): GitUnpushedCommit {
  return {
    sha: commit.sha,
    message: commit.message,
    author: commit.author,
    timestamp: commit.timestamp,
  };
}

export async function getGitPublishPromptState(
  spacePath: string,
): Promise<GitPublishPromptState> {
  const cfg = await getSpaceConfig(spacePath);
  const remote = await getGitRemote(spacePath);
  const hasRemote = !!remote && remote.trim().length > 0;
  const autoSync = cfg.git?.autoSync === true;

  if (!hasRemote || autoSync) {
    return { visible: false, commits: [] };
  }

  const commits = await getGitUnpushedCommits(spacePath);
  return {
    visible: commits.length > 0,
    commits,
  };
}

export function getGitUnpushedCommits(
  spacePath: string,
): Promise<GitUnpushedCommit[]> {
  return getUnpushedCommits(spacePath).then((commits) =>
    commits.map(toGitUnpushedCommit),
  );
}

export function listenGitPublishCommits(
  handler: GitPublishCommitHandler,
): Promise<GitPublishUnlistenFn> {
  return listenGitCommitted((event) => handler(event.payload.spacePath));
}

export async function publishGitCommits({
  spacePath,
  projectPath,
  enableAutoSync: shouldEnableAutoSync,
}: PublishGitCommitsInput): Promise<void> {
  const status = await publishGit(spacePath);
  useGitStore.getState().applyStatus(spacePath, status);

  if (shouldEnableAutoSync) {
    await enableGitAutoSync({
      spacePath,
      projectPath,
    });
  }
}

export function isRemoteRepositoryNotEmptyError(error: unknown): boolean {
  return String(error).includes("Remote repository is not empty");
}

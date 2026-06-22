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
import type {
  EventCallback,
  UnlistenFn,
} from "@/platform/native/events";

export type GitUnpushedCommit = UnpushedCommitDto;

export interface GitPublishPromptState {
  visible: boolean;
  commits: GitUnpushedCommit[];
}

export interface PublishGitCommitsInput {
  spacePath: string;
  projectPath?: string | null;
  enableAutoSync: boolean;
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

  const commits = await getUnpushedCommits(spacePath);
  return {
    visible: commits.length > 0,
    commits,
  };
}

export function getGitUnpushedCommits(
  spacePath: string,
): Promise<GitUnpushedCommit[]> {
  return getUnpushedCommits(spacePath);
}

export function listenGitPublishCommits(
  handler: EventCallback<{ spacePath: string }>,
): Promise<UnlistenFn> {
  return listenGitCommitted(handler);
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

import * as m from "@/paraglide/messages.js";

import type { GitUnpushedCommit } from "../model";

export interface GitSyncCommitsProps {
  remoteChecked: boolean;
  checkingRemote: boolean;
  incoming: number | null;
  outgoing: number | null;
  commits: GitUnpushedCommit[];
  commitsFailed: boolean;
  loadingCommits: boolean;
  moreCommits: number;
}

/**
 * What waits in the Git sync Dialog (Stage 11 1.E): the outgoing commits by
 * title and the number of incoming ones, or one line when nothing waits.
 */
export function GitSyncCommits({
  remoteChecked,
  checkingRemote,
  incoming,
  outgoing,
  commits,
  commitsFailed,
  loadingCommits,
  moreCommits,
}: GitSyncCommitsProps) {
  if (!remoteChecked) {
    return (
      <p className="text-sm text-muted-foreground" data-git-sync-unchecked>
        {checkingRemote
          ? m.git_sync_remote_checking()
          : m.git_sync_outgoing_unchecked()}
      </p>
    );
  }
  const outgoingCount = outgoing ?? 0;
  const incomingCount = incoming ?? 0;
  if (outgoingCount === 0 && incomingCount === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-git-sync-nothing>
        {m.git_sync_dialog_nothing()}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section className="flex min-w-0 flex-col gap-1" data-git-sync-outgoing>
        <h3 className="text-sm font-medium">
          {m.git_sync_dialog_outgoing({ count: String(outgoingCount) })}
        </h3>
        {outgoingCount > 0 &&
          (commitsFailed ? (
            <p
              className="text-sm text-muted-foreground"
              data-git-outgoing-failed
            >
              {m.git_sync_outgoing_load_failed()}
            </p>
          ) : commits.length === 0 ? (
            loadingCommits && (
              <p className="text-sm text-muted-foreground">
                {m.git_unpushed_loading()}
              </p>
            )
          ) : (
            <ul className="flex max-h-[240px] min-w-0 flex-col gap-1 overflow-y-auto text-sm">
              {commits.map((commit) => (
                <li
                  key={commit.sha}
                  className="truncate"
                  title={`${commit.sha} · ${commit.author}`}
                  data-git-commit={commit.sha}
                >
                  {commit.message}
                </li>
              ))}
              {moreCommits > 0 && (
                <li className="text-muted-foreground" data-git-outgoing-more>
                  {m.git_sync_outgoing_more({ count: String(moreCommits) })}
                </li>
              )}
            </ul>
          ))}
      </section>
      <section className="min-w-0" data-git-sync-incoming>
        <h3 className="text-sm font-medium">
          {m.git_sync_dialog_incoming({ count: String(incomingCount) })}
        </h3>
      </section>
    </div>
  );
}

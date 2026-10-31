import {
  CloudUpload,
  GitCommitHorizontal,
  GitMerge,
  RefreshCw,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { gitPublicationStopMessage, shortCommit } from "../api/git-sync-error";
import type { GitServiceMerge } from "../hooks/use-git-service-merge";
import type { GitServiceFile, GitSyncStop } from "../model";
import { gitSaveErrorDescription } from "./git-save-error-copy";
import { gitServiceFileLabel, gitSyncStopTitle } from "./git-sync-stop-copy";
import * as m from "@/paraglide/messages.js";

/**
 * The slot of the Git sync Dialog for what stops sync or its publication: it
 * takes the place of the sync error and names what the user resolves and where.
 */
export function GitSyncStopNotice({
  stop,
  onOpenPage,
  serviceMerge,
}: {
  stop: GitSyncStop;
  onOpenPage?: (path: string) => void;
  /** The service-file actions of a merge stop. */
  serviceMerge?: GitServiceMerge;
}) {
  const service = new Map(
    (stop.kind === "conflict" ? stop.service : []).map((file) => [
      file.path,
      file,
    ]),
  );
  const mergeable =
    !!serviceMerge &&
    [...service.values()].some((file) => file.state === "mergeable");
  return (
    <Alert data-git-sync-stop={stop.kind}>
      {stop.kind === "publication" ? (
        <CloudUpload />
      ) : stop.kind === "commit" ? (
        <GitCommitHorizontal />
      ) : (
        <GitMerge />
      )}
      <AlertTitle className="break-words">{gitSyncStopTitle(stop)}</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2">
        {stop.kind === "publication" ? (
          <PublicationStopDetails stop={stop} />
        ) : stop.kind === "commit" ? (
          <>
            <div data-commit-stop-cause>
              {gitSaveErrorDescription({ outcome: "failed", ...stop })}
            </div>
            <div>{m.git_sync_stop_commit_hint()}</div>
          </>
        ) : stop.kind !== "operation" ? (
          <>
            <div>
              {stop.kind === "conflict"
                ? m.git_sync_stop_conflict_description()
                : m.git_sync_stop_unmerged_description()}
            </div>
            {stop.files.length > 0 && (
              <ul
                aria-label={m.git_sync_stop_conflict_files()}
                className="flex max-h-40 min-w-0 flex-col gap-1 overflow-y-auto"
              >
                {stop.files.map((path) => (
                  <li key={path} className="flex min-w-0 items-baseline gap-2">
                    {service.has(path) ? (
                      <ServiceFileRow
                        file={service.get(path)!}
                        serviceMerge={serviceMerge}
                      />
                    ) : onOpenPage && isMarkdownPage(path) ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto min-w-0 max-w-full shrink justify-start p-0 text-sm"
                        title={path}
                        aria-label={m.git_sync_stop_open_page({ path })}
                        onClick={() => onOpenPage(path)}
                      >
                        <span className="min-w-0 truncate">{path}</span>
                      </Button>
                    ) : (
                      <>
                        <span
                          className="min-w-0 truncate text-foreground"
                          title={path}
                        >
                          {path}
                        </span>
                        {!isMarkdownPage(path) && (
                          <span className="shrink-0 text-xs">
                            {m.git_sync_stop_resolved_in_git()}
                          </span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {mergeable && (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!!serviceMerge.running}
                  onClick={() => void serviceMerge.mergeAll()}
                  data-git-service-merge-action
                >
                  {serviceMerge.running?.kind === "merge" && (
                    <RefreshCw
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  )}
                  {m.git_sync_service_merge_action()}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div>{m.git_sync_stop_operation_description()}</div>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** The file and commit the guard kept local, and how publication resumes. */
function PublicationStopDetails({
  stop,
}: {
  stop: Extract<GitSyncStop, { kind: "publication" }>;
}) {
  return (
    <>
      <div>{gitPublicationStopMessage(stop)}</div>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
        <dt>{m.git_sync_stop_publication_file()}</dt>
        <dd
          className="min-w-0 truncate text-foreground"
          title={stop.path}
          data-publication-stop-path
        >
          {stop.path}
        </dd>
        <dt>{m.git_sync_stop_publication_commit()}</dt>
        <dd
          className="min-w-0 truncate font-mono text-xs text-foreground"
          title={stop.commit}
          data-publication-stop-commit
        >
          {shortCommit(stop.commit)}
        </dd>
      </dl>
      <div>{m.git_sync_stop_publication_hint()}</div>
    </>
  );
}

/**
 * A conflicted Svode service file: what the rule set says about it and, for
 * a Space pointer it cannot resolve, the Space sync after which it does.
 */
function ServiceFileRow({
  file,
  serviceMerge,
}: {
  file: GitServiceFile;
  serviceMerge?: GitServiceMerge;
}) {
  const syncing =
    serviceMerge?.running?.kind === "space" &&
    serviceMerge.running.path === file.path;
  return (
    <span
      className="flex min-w-0 flex-wrap items-baseline gap-x-2"
      data-git-service-file={file.state}
    >
      <span className="min-w-0 truncate text-foreground" title={file.path}>
        {file.path}
      </span>
      <span className="text-xs">{gitServiceFileLabel(file)}</span>
      {serviceMerge && file.state !== "mergeable" && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs"
          disabled={!!serviceMerge.running}
          onClick={() => void serviceMerge.syncSpace(file.path)}
          data-git-service-space-sync
        >
          {syncing && (
            <RefreshCw data-icon="inline-start" className="animate-spin" />
          )}
          {m.git_sync_service_space_sync_action()}
        </Button>
      )}
    </span>
  );
}

function isMarkdownPage(path: string) {
  return path.toLowerCase().endsWith(".md");
}

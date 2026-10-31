import { CloudUpload, GitMerge } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { gitPublicationStopMessage, shortCommit } from "../api/git-sync-error";
import type { GitSyncStop } from "../model";
import { gitSyncStopTitle } from "./git-sync-stop-copy";
import * as m from "@/paraglide/messages.js";

/**
 * The slot of the Git sync Dialog for what stops sync or its publication: it
 * takes the place of the sync error and names what the user resolves and where.
 */
export function GitSyncStopNotice({
  stop,
  onOpenPage,
}: {
  stop: GitSyncStop;
  onOpenPage?: (path: string) => void;
}) {
  return (
    <Alert data-git-sync-stop={stop.kind}>
      {stop.kind === "publication" ? <CloudUpload /> : <GitMerge />}
      <AlertTitle className="break-words">{gitSyncStopTitle(stop)}</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-2">
        {stop.kind === "publication" ? (
          <PublicationStopDetails stop={stop} />
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
                    {onOpenPage && isMarkdownPage(path) ? (
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

function isMarkdownPage(path: string) {
  return path.toLowerCase().endsWith(".md");
}

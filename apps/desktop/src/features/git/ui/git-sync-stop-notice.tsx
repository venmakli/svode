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
import {
  conflictInPageEditor,
  conflictPartners,
  type GitConflictKind,
  type GitServiceFile,
  type GitSyncStop,
} from "../model";
import { gitSaveErrorDescription } from "./git-save-error-copy";
import {
  gitConflictKindLabel,
  gitServiceFileLabel,
  gitSyncStopTitle,
} from "./git-sync-stop-copy";
import * as m from "@/paraglide/messages.js";

/**
 * The slot of the Git sync Dialog for what stops sync or its publication: it
 * takes the place of the sync error and names what the user resolves and where.
 */
export function GitSyncStopNotice({
  stop,
  onOpenPage,
  fileResolver,
  nameOf,
  serviceMerge,
}: {
  stop: GitSyncStop;
  /** Open a conflicted Page in its editor; `path` is relative to the repository. */
  onOpenPage?: (path: string) => void;
  /**
   * Opens "Changes" at a conflicted file, when they can be opened; `path` is
   * relative to the repository.
   */
  fileResolver?: (path: string) => (() => void) | undefined;
  /** The name the person knows a path of the repository by. */
  nameOf?: (path: string) => string;
  /** The service-file actions of a merge stop. */
  serviceMerge?: GitServiceMerge;
}) {
  const service = new Map(
    (stop.kind === "conflict" ? stop.service : []).map((file) => [
      file.path,
      file,
    ]),
  );
  const conflicts =
    stop.kind === "conflict" || stop.kind === "unmerged" ? stop.kinds : [];
  const kinds = new Map(conflicts.map((file) => [file.path, file.kind]));
  // A conflict of several paths is one row, at its entry.
  const partners = conflictPartners(conflicts);
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
        ) : stop.kind === "incoming" ? (
          <IncomingStopDetails stop={stop} nameOf={nameOf} />
        ) : stop.kind === "explicit_sync" ? (
          <div>{m.git_sync_stop_explicit_description()}</div>
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
                {stop.files
                  .filter((path) => !partners.has(path))
                  .map((path) => (
                    <li
                      key={path}
                      className="flex min-w-0 items-baseline gap-2"
                    >
                      {service.has(path) ? (
                        <ServiceFileRow
                          file={service.get(path)!}
                          serviceMerge={serviceMerge}
                        />
                      ) : (
                        <ConflictPathRow
                          path={path}
                          name={nameOf?.(path) ?? path}
                          kind={kinds.get(path)}
                          onOpenPage={onOpenPage}
                          fileResolver={fileResolver}
                        />
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
          <div>{m.git_sync_stop_operation_actions()}</div>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The paths whose incoming changes conflict with local ones, each by its
 * name with its kind; nothing is merged until the user syncs.
 */
function IncomingStopDetails({
  stop,
  nameOf,
}: {
  stop: Extract<GitSyncStop, { kind: "incoming" }>;
  nameOf?: (path: string) => string;
}) {
  const service = new Map(stop.service.map((file) => [file.path, file]));
  return (
    <>
      <div>{m.git_sync_stop_incoming_description()}</div>
      {stop.files.length > 0 && (
        <ul
          aria-label={m.git_sync_stop_conflict_files()}
          className="flex max-h-40 min-w-0 flex-col gap-1 overflow-y-auto"
        >
          {stop.files.map((file) => {
            const serviceFile = service.get(file.path);
            return (
              <li
                key={file.path}
                className="flex min-w-0 items-baseline gap-2"
                data-git-incoming-conflict={file.kind}
              >
                <span
                  className="min-w-0 truncate text-foreground"
                  title={file.path}
                >
                  {nameOf?.(file.path) ?? file.path}
                </span>
                <span className="shrink-0 text-xs">
                  {serviceFile && serviceFile.state !== "mergeable"
                    ? `${gitConflictKindLabel(file.kind)} · ${gitServiceFileLabel(serviceFile)}`
                    : gitConflictKindLabel(file.kind)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/**
 * An unresolved path of a merge or of files in conflict without an
 * operation: its name, its kind and «Разрешить», which opens a Page in its
 * editor and any other file in "Changes".
 */
function ConflictPathRow({
  path,
  name,
  kind,
  onOpenPage,
  fileResolver,
}: {
  path: string;
  name: string;
  kind: GitConflictKind | undefined;
  onOpenPage?: (path: string) => void;
  fileResolver?: (path: string) => (() => void) | undefined;
}) {
  const resolve = conflictInPageEditor(path, kind)
    ? onOpenPage && (() => onOpenPage(path))
    : fileResolver?.(path);
  return (
    <span
      className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2"
      data-git-conflict-path={path}
      data-git-conflict-kind={kind}
    >
      <span className="min-w-0 truncate text-foreground" title={path}>
        {name}
      </span>
      {kind && (
        <span className="shrink-0 text-xs">{gitConflictKindLabel(kind)}</span>
      )}
      {resolve && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto shrink-0 p-0 text-xs"
          aria-label={m.git_sync_stop_resolve_path({ name })}
          onClick={resolve}
          data-git-conflict-resolve
        >
          {m.git_sync_stop_resolve()}
        </Button>
      )}
    </span>
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

import { GitPublicationResult } from "./git-publication-result";
import { publicationCopy } from "./git-publication-copy";
import {
  AlertTriangle,
  Check,
  CircleHelp,
  GitBranch,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useGitSyncWidget } from "../hooks/use-git-sync-widget";
import { useRepositoryAccess } from "../hooks/use-repository-access";
import { useRepositoryAccessActivation } from "../hooks/use-repository-access-activation";
import { GitRemoteAuthDialog } from "./git-remote-auth-dialog";
import {
  repositoryAccessPresentation,
  type RepositoryAccessPresentation,
} from "./repository-access-copy";
import { RepositoryAccessSection } from "./repository-access-section";
import * as m from "@/paraglide/messages.js";

export interface GitSyncStatusWidgetProps {
  // Only the content surface activates access checks; elsewhere the
  // indicator passively reads the canonical local snapshot.
  activateAccess?: boolean;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
}

export function GitSyncStatusWidget({
  activateAccess = false,
  onOpenRepositorySettings,
}: GitSyncStatusWidgetProps) {
  const sync = useGitSyncWidget();
  useRepositoryAccessActivation(sync.spacePath, activateAccess);
  const access = useRepositoryAccess(sync.spacePath);
  const presentation = repositoryAccessPresentation(access);
  const accessLabel = accessIndicatorLabel(presentation.status);

  if (!sync.spacePath || (!sync.visible && !accessLabel)) return null;

  const busy = sync.syncing || sync.checkingRemote || sync.parent.busy;
  const pendingParent =
    sync.parent.publication &&
    sync.parent.publication.parent.pointer !== "published";
  const error = sync.syncError ?? sync.remoteError;
  const hasSyncError = !!error;
  const synced =
    sync.remoteChecked && sync.incoming === 0 && sync.outgoing === 0;
  const syncLabel = sync.visible
    ? syncStateLabel({
        busy,
        hasSyncError,
        incoming: sync.incoming,
        outgoing: sync.outgoing,
        parentLabel: sync.parent.publication
          ? publicationCopy(sync.parent.publication).parent
          : null,
        pendingParent: !!pendingParent,
        remoteChecked: sync.remoteChecked,
        synced,
      })
    : null;
  const label = [
    m.git_repository_control_branch({ branch: sync.branch }),
    accessLabel,
    syncLabel,
  ]
    .filter(Boolean)
    .join(", ");
  const openSettings = onOpenRepositorySettings
    ? () => {
        sync.setOpen(false);
        onOpenRepositorySettings(sync.spacePath);
      }
    : undefined;

  return (
    <>
      <Dialog
        open={sync.open}
        onOpenChange={(open) => {
          if (!open) sync.setOpen(false);
          else if (sync.visible) void sync.openDialog();
          else sync.setOpen(true);
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  "max-w-[260px]",
                  sync.autoSync && "text-muted-foreground",
                  hasSyncError && "text-destructive hover:text-destructive",
                )}
                aria-label={label}
                aria-busy={busy || presentation.status === "checking"}
                data-repository-control
                data-repository-access-state={presentation.status}
              >
                <GitBranch data-icon="inline-start" />
                <span className="min-w-0 truncate">{sync.branch}</span>
                {accessLabel ? (
                  <span
                    className="flex shrink-0 items-center gap-1"
                    data-repository-access-indicator={presentation.status}
                  >
                    <AccessIndicatorIcon status={presentation.status} />
                    {presentation.status === "read_only" ? (
                      <span className="hidden lg:inline">
                        {m.repository_work_status_read_only()}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {sync.visible ? (
                  <span
                    className="flex shrink-0 items-center gap-1 font-mono text-xs"
                    data-git-sync-indicator
                  >
                    {busy ? (
                      <RefreshCw className="animate-spin" />
                    ) : hasSyncError || pendingParent ? (
                      <AlertTriangle />
                    ) : synced ? (
                      <Check data-git-sync-synced />
                    ) : null}
                    {synced ? null : (
                      <>
                        <span>{counterLabel(sync.incoming)}↓</span>
                        <span>{counterLabel(sync.outgoing)}↑</span>
                      </>
                    )}
                  </span>
                ) : null}
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[560px] overflow-hidden sm:max-w-[560px]">
          <DialogHeader className="min-w-0">
            <DialogTitle>{m.git_sync_modal_title()}</DialogTitle>
            <DialogDescription className="break-words">
              {m.git_sync_modal_description({ branch: sync.branch })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-w-0 flex-col gap-3 max-h-[65vh] overflow-y-auto">
            <RepositoryAccessSection
              presentation={presentation}
              repositoryPath={sync.spacePath}
              verify={access.verify}
              onOpenSettings={openSettings}
            />
            {sync.visible ? (
              <>
                <Separator />
                {sync.parent.publication && (
                  <GitPublicationResult
                    publication={sync.parent.publication}
                    error={sync.parent.error}
                  />
                )}
                {hasSyncError && (
                  <Alert variant="destructive">
                    <AlertTriangle />
                    <AlertDescription className="whitespace-pre-wrap break-words">
                      {error}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {m.git_sync_incoming_summary({
                      count: counterLabel(sync.incoming),
                    })}
                  </Badge>
                  <Badge variant="outline">
                    {m.git_sync_outgoing_summary({
                      count: counterLabel(sync.outgoing),
                    })}
                  </Badge>
                  {sync.autoSync && (
                    <Badge variant="secondary">{m.git_sync_auto_badge()}</Badge>
                  )}
                </div>

                <Separator />

                <section className="flex min-w-0 flex-col gap-2">
                  <div className="text-sm font-medium">
                    {m.git_sync_outgoing_section()}
                  </div>
                  <div className="max-h-[240px] min-w-0 overflow-y-auto overflow-x-hidden rounded-md border">
                    {!sync.remoteChecked ? (
                      <p className="p-4 text-sm text-muted-foreground">
                        {sync.checkingRemote
                          ? m.git_sync_remote_checking()
                          : m.git_sync_outgoing_unchecked()}
                      </p>
                    ) : sync.loadingCommits ? (
                      <p className="p-4 text-sm text-muted-foreground">
                        {m.git_unpushed_loading()}
                      </p>
                    ) : sync.commits.length === 0 ? (
                      <p className="p-4 text-sm text-muted-foreground">
                        {m.git_sync_outgoing_empty()}
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {sync.commits.map((commit) => (
                          <li key={commit.sha} className="min-w-0 p-3 text-sm">
                            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2">
                              <span className="truncate font-mono text-xs text-muted-foreground">
                                {commit.sha}
                              </span>
                              <span className="max-w-32 truncate text-xs text-muted-foreground sm:max-w-40">
                                {commit.author}
                              </span>
                            </div>
                            <p className="mt-1 truncate">{commit.message}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>

                <label className="flex min-w-0 cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={sync.autoSync}
                    disabled={sync.savingAutoSync}
                    onCheckedChange={(checked) =>
                      void sync.setAutoSync(checked === true)
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0 text-sm">
                    {m.git_sync_auto_label()}
                    <span className="block text-xs text-muted-foreground">
                      {m.git_sync_auto_hint()}
                    </span>
                  </span>
                </label>
              </>
            ) : null}
          </div>

          <DialogFooter className="min-w-0">
            {sync.visible && sync.parent.action !== "none" && (
              <Button
                className="w-full sm:w-auto"
                onClick={
                  sync.parent.action === "sync" ? sync.syncNow : sync.parent.run
                }
                disabled={busy}
              >
                {sync.syncing && (
                  <RefreshCw
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                )}
                {sync.parent.action === "sync"
                  ? m.git_sync_action()
                  : sync.parent.label}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GitRemoteAuthDialog
        open={sync.parent.authOpen}
        challenge={sync.parent.challenge}
        saving={sync.parent.busy}
        error={sync.parent.error}
        onOpenChange={sync.parent.setAuthOpen}
        onSaveAndRetry={sync.parent.saveAuthAndRetry}
      />
      <GitRemoteAuthDialog
        open={sync.authOpen}
        challenge={sync.authChallenge}
        saving={sync.authSaving}
        error={sync.authError}
        onOpenChange={sync.setAuthOpen}
        onSaveAndRetry={sync.saveAuthAndRetry}
      />
    </>
  );
}

function counterLabel(count: number | null): string {
  return count == null ? "?" : String(count);
}

function AccessIndicatorIcon({
  status,
}: {
  status: RepositoryAccessPresentation["status"];
}) {
  switch (status) {
    case "checking":
      return <LoaderCircle className="animate-spin" />;
    case "read_only":
      return <LockKeyhole />;
    case "unknown":
      return <CircleHelp />;
    case "error":
      return <AlertTriangle className="text-destructive" />;
    default:
      return null;
  }
}

// Normal access and the local reread stay silent; only exceptions show.
function accessIndicatorLabel(
  status: RepositoryAccessPresentation["status"],
): string | null {
  switch (status) {
    case "checking":
      return m.repository_work_status_checking();
    case "read_only":
      return m.repository_work_status_read_only();
    case "unknown":
      return m.git_access_status_unknown_label();
    case "error":
      return m.git_access_status_error_label();
    case "local":
    case "writable":
    case "loading":
      return null;
  }
}

function syncStateLabel({
  busy,
  hasSyncError,
  incoming,
  outgoing,
  parentLabel,
  pendingParent,
  remoteChecked,
  synced,
}: {
  busy: boolean;
  hasSyncError: boolean;
  incoming: number | null;
  outgoing: number | null;
  parentLabel: string | null;
  pendingParent: boolean;
  remoteChecked: boolean;
  synced: boolean;
}): string {
  if (hasSyncError) return m.git_status_error();
  if (busy) return m.git_status_syncing();
  const counters = !remoteChecked
    ? m.git_sync_remote_unchecked_tooltip()
    : synced
      ? m.git_sync_state_synced()
      : `${m.git_sync_incoming_summary({ count: counterLabel(incoming) })}, ${m.git_sync_outgoing_summary({ count: counterLabel(outgoing) })}`;
  return pendingParent && parentLabel
    ? `${parentLabel}, ${counters}`
    : counters;
}

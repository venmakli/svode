import { AlertTriangle, GitBranch, RefreshCw } from "lucide-react";
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
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { useGitSyncWidget } from "../hooks/use-git-sync-widget";
import { GitRemoteAuthDialog } from "./git-remote-auth-dialog";
import * as m from "@/paraglide/messages.js";

export function GitSyncStatusWidget() {
  const sync = useGitSyncWidget();

  if (!sync.visible) return null;

  const busy = sync.syncing || sync.checkingRemote;
  const hasSyncError = !!sync.syncError;
  const tooltip = hasSyncError
    ? m.git_status_error()
    : busy
      ? m.git_status_syncing()
      : m.git_sync_widget_tooltip();

  return (
    <>
      <div
        className={cn(
          "flex h-7 max-w-[260px] items-center gap-1 rounded-lg px-1 text-xs",
          sync.autoSync && "text-muted-foreground",
          hasSyncError && "text-destructive",
        )}
      >
        <div className="flex min-w-0 items-center gap-1 px-1.5">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-medium">{sync.branch}</span>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-7 px-2 font-mono text-xs",
                hasSyncError && "text-destructive hover:text-destructive",
              )}
              onClick={sync.openDialog}
              aria-label={tooltip}
            >
              {busy ? (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              ) : hasSyncError ? (
                <AlertTriangle data-icon="inline-start" />
              ) : null}
              <span>{counterLabel(sync.incoming)}↓</span>
              <span>{counterLabel(sync.outgoing)}↑</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{tooltip}</TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={sync.open} onOpenChange={sync.setOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[560px] overflow-hidden sm:max-w-[560px]">
          <DialogHeader className="min-w-0">
            <DialogTitle>{m.git_sync_modal_title()}</DialogTitle>
            <DialogDescription className="break-words">
              {m.git_sync_modal_description({ branch: sync.branch })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-w-0 flex-col gap-3">
            {hasSyncError && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>
                  {sync.remoteChecked
                    ? m.git_sync_error_description()
                    : m.git_sync_remote_unchecked_description()}
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
                {sync.loadingCommits ? (
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
          </div>

          <DialogFooter className="min-w-0">
            <Button
              className="w-full sm:w-auto"
              onClick={sync.syncNow}
              disabled={sync.syncing}
            >
              {sync.syncing && (
                <RefreshCw data-icon="inline-start" className="animate-spin" />
              )}
              {m.git_sync_action()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

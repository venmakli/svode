import { LoaderCircle } from "lucide-react";
import { getLocale } from "@/paraglide/runtime.js";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { GitRemoteAuthDialog } from "./git-remote-auth-dialog";

import { useRepositoryAccessActivation } from "../hooks/use-repository-access-activation";
import { useRepositoryAccess } from "../hooks/use-repository-access";
import { useRepositoryAccessRecovery } from "../hooks/use-repository-access-recovery";
import { repositoryAccessPresentation } from "./repository-access-copy";
import { RepositoryAccessStatusIcon } from "./repository-access-status-icon";

export interface RepositoryAccessSummaryProps {
  remoteUrl: string;
  repositoryPath: string;
  onEditRemote(): void;
  className?: string;
}

// Repository access as the content of a settings card: the host supplies the
// heading, the owner and the container.
export function RepositoryAccessSummary({
  remoteUrl,
  repositoryPath,
  onEditRemote,
  className,
}: RepositoryAccessSummaryProps) {
  useRepositoryAccessActivation(repositoryPath);
  const access = useRepositoryAccess(repositoryPath);
  const presentation = repositoryAccessPresentation(access);
  const recovery = useRepositoryAccessRecovery({
    remoteUrl,
    verify: access.verify,
    onEditRemote,
  });
  const busy = access.verifying || presentation.status === "checking";

  return (
    <>
      <div
        className={cn("flex min-w-0 flex-col gap-3", className)}
        aria-busy={busy}
        data-repository-access-summary
        data-repository-access-status={presentation.status}
      >
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2"
          aria-live="polite"
        >
          <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
            <p className="text-sm font-medium">{presentation.title}</p>
            <p className="text-sm text-muted-foreground">
              {presentation.description}
            </p>
          </div>
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
            <Badge
              variant={
                presentation.status === "error" ? "destructive" : "secondary"
              }
            >
              <RepositoryAccessStatusIcon
                status={presentation.status}
                busy={busy}
              />
              {presentation.statusLabel}
            </Badge>
            {presentation.action !== "none" && presentation.actionLabel && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => recovery.runPrimaryAction(presentation.action)}
              >
                {busy && (
                  <LoaderCircle
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                )}
                {presentation.actionLabel}
              </Button>
            )}
          </div>
        </div>

        {recovery.recommendationsOpen && (
          <p className="text-xs text-muted-foreground" role="status">
            {m.git_access_unsupported_ref_recommendations()}
          </p>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            {m.git_access_details()}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {access.snapshot?.checkedAt && (
              <p>
                {m.git_access_checked_at({
                  value: formatTimestamp(access.snapshot.checkedAt),
                })}
              </p>
            )}
            {access.snapshot?.expiresAt && (
              <p>
                {m.git_access_expires_at({
                  value: formatTimestamp(access.snapshot.expiresAt),
                })}
              </p>
            )}
            {access.snapshot?.lastKnownStatus && (
              <p>
                {m.git_access_last_known({
                  value: access.snapshot.lastKnownStatus,
                })}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {presentation.status === "writable" && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void access.verify()}
                >
                  {m.git_access_action_check_again()}
                </Button>
              )}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={onEditRemote}
              >
                {remoteUrl.trim()
                  ? m.git_access_action_open_origin()
                  : m.git_access_action_setup_origin()}
              </Button>
            </div>
          </div>
        </details>
      </div>

      <GitRemoteAuthDialog
        open={recovery.authOpen}
        challenge={recovery.challenge}
        saving={recovery.authSaving}
        error={recovery.authError}
        onOpenChange={recovery.handleAuthOpenChange}
        onSaveAndRetry={recovery.saveAuthAndVerify}
      />
    </>
  );
}

// A passive status for a collapsed owner: reading it never starts a check.
export function RepositoryAccessBadge({
  repositoryPath,
}: {
  repositoryPath: string;
}) {
  const access = useRepositoryAccess(repositoryPath);
  const presentation = repositoryAccessPresentation(access);
  return (
    <Badge
      className="max-w-full"
      variant={presentation.status === "error" ? "destructive" : "outline"}
      data-repository-access-row-status={presentation.status}
    >
      {presentation.statusLabel}
    </Badge>
  );
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1_000));
}

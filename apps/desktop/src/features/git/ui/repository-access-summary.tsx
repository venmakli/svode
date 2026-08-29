import {
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";
import { getLocale } from "@/paraglide/runtime.js";
import * as m from "@/paraglide/messages.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GitRemoteAuthDialog } from "./git-remote-auth-dialog";

import { useRepositoryAccess } from "../hooks/use-repository-access";
import { useRepositoryAccessRecovery } from "../hooks/use-repository-access-recovery";
import { repositoryAccessPresentation } from "./repository-access-copy";

export type RepositoryAccessOwnerKind =
  | "project"
  | "inline"
  | "independent"
  | "submodule";

export interface RepositoryAccessSummaryProps {
  displayPath: string;
  ownerKind: RepositoryAccessOwnerKind;
  ownerName: string;
  remoteUrl: string;
  repositoryPath: string;
  onEditRemote(): void;
}

export function RepositoryAccessSummary({
  displayPath,
  ownerKind,
  ownerName,
  remoteUrl,
  repositoryPath,
  onEditRemote,
}: RepositoryAccessSummaryProps) {
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
      <section
        className="flex min-w-0 flex-col gap-3 rounded-md border p-3"
        aria-busy={busy}
        data-repository-access-summary
        data-repository-access-status={presentation.status}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-medium">{m.git_access_title()}</h2>
            <p className="text-xs text-muted-foreground">
              {repositoryOwnerLabel(ownerKind, ownerName)}
            </p>
            <p
              className="break-all text-xs text-muted-foreground"
              title={displayPath}
            >
              {displayPath}
            </p>
          </div>
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
        </div>

        <div className="flex min-w-0 items-start gap-2" aria-live="polite">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-sm font-medium">{presentation.title}</p>
            <p className="text-xs text-muted-foreground">
              {presentation.description}
            </p>
          </div>
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
              {ownerKind !== "inline" && (
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
              )}
            </div>
          </div>
        </details>
      </section>

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

export function RepositoryAccessBadge({
  ownerKind,
  repositoryPath,
}: {
  ownerKind: RepositoryAccessOwnerKind;
  repositoryPath: string;
}) {
  const access = useRepositoryAccess(repositoryPath);
  const presentation = repositoryAccessPresentation(access);
  const label =
    ownerKind === "inline"
      ? m.git_access_inline_badge({ status: presentation.statusLabel })
      : presentation.statusLabel;
  return (
    <Badge
      className="max-w-full"
      variant={presentation.status === "error" ? "destructive" : "outline"}
      aria-label={label}
      data-repository-access-row-status={presentation.status}
    >
      {label}
    </Badge>
  );
}

function repositoryOwnerLabel(
  ownerKind: RepositoryAccessOwnerKind,
  ownerName: string,
) {
  switch (ownerKind) {
    case "project":
      return m.git_access_owner_project({ name: ownerName });
    case "inline":
      return m.git_access_owner_inline({ name: ownerName });
    case "independent":
      return m.git_access_owner_independent({ name: ownerName });
    case "submodule":
      return m.git_access_owner_submodule({ name: ownerName });
  }
}

function RepositoryAccessStatusIcon({
  status,
  busy,
}: {
  status: ReturnType<typeof repositoryAccessPresentation>["status"];
  busy: boolean;
}) {
  const className = busy ? "animate-spin" : undefined;
  switch (status) {
    case "local":
    case "writable":
      return <CheckCircle2 data-icon="inline-start" className={className} />;
    case "checking":
    case "loading":
      return <LoaderCircle data-icon="inline-start" className={className} />;
    case "read_only":
      return <LockKeyhole data-icon="inline-start" className={className} />;
    case "error":
      return <TriangleAlert data-icon="inline-start" className={className} />;
    case "unknown":
      return <CircleHelp data-icon="inline-start" className={className} />;
  }
}

function formatTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1_000));
}

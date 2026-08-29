import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";
import { useRef } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as m from "@/paraglide/messages.js";

import type { RepositoryAccessPreflightController } from "../hooks/use-repository-access-preflight";
import type { RepositoryAccessTargetView } from "../model/repository-access-consumer";
import { repositoryAccessPresentation } from "./repository-access-copy";

export function RepositoryAccessPreflightDialog({
  recovery,
}: {
  recovery: RepositoryAccessPreflightController;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  if (!recovery.open || recovery.pending?.placement !== "dialog") return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) recovery.close();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        aria-busy={recovery.busy}
        data-repository-access-preflight
        data-repository-access-intent={recovery.pending.intentKey}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} className="outline-none" tabIndex={-1}>
            {m.git_access_preflight_title()}
          </DialogTitle>
          <DialogDescription>
            {m.git_access_preflight_description({
              action: recovery.pending.intentLabel,
            })}
          </DialogDescription>
        </DialogHeader>

        <RepositoryAccessRecoveryBody recovery={recovery} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={recovery.close}>
            {m.git_access_preflight_cancel()}
          </Button>
          <RepositoryAccessPrimaryButton recovery={recovery} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RepositoryAccessInlineRecovery({
  recovery,
}: {
  recovery: RepositoryAccessPreflightController;
}) {
  if (!recovery.open || recovery.pending?.placement !== "inline") return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      aria-busy={recovery.busy}
      data-repository-access-inline-recovery
      data-repository-access-intent={recovery.pending.intentKey}
    >
      <RepositoryAccessRecoveryBody recovery={recovery} />
    </div>
  );
}

export function RepositoryAccessPrimaryButton({
  recovery,
}: {
  recovery: RepositoryAccessPreflightController;
}) {
  if (!recovery.open || !recovery.pending) return null;
  const label = repositoryAccessPrimaryActionLabel(recovery);
  if (!label) return null;

  return (
    <Button
      type="button"
      disabled={recovery.busy}
      onClick={recovery.runPrimaryAction}
    >
      {recovery.busy ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : null}
      {label}
    </Button>
  );
}

export function repositoryAccessPrimaryActionLabel(
  recovery: RepositoryAccessPreflightController,
) {
  if (!recovery.open || !recovery.pending) return null;
  if (recovery.readyToRetry) {
    return m.git_access_preflight_retry({
      action: recovery.pending.intentLabel,
    });
  }
  return recovery.busy
    ? m.git_access_action_checking()
    : recovery.primaryActionLabel;
}

function RepositoryAccessRecoveryBody({
  recovery,
}: {
  recovery: RepositoryAccessPreflightController;
}) {
  if (recovery.readyToRetry) {
    return (
      <Alert data-repository-access-ready>
        <CheckCircle2 />
        <AlertTitle>{m.git_access_preflight_ready_title()}</AlertTitle>
        <AlertDescription>
          {m.git_access_preflight_ready_description()}
        </AlertDescription>
      </Alert>
    );
  }

  const targets = recovery.blockers.length
    ? recovery.blockers
    : recovery.targetViews;
  return (
    <div className="flex max-h-72 min-w-0 flex-col gap-2 overflow-y-auto">
      {targets.map((target) => (
        <RepositoryAccessTargetAlert
          key={
            target.access.snapshot?.repositoryId ?? target.target.repositoryPath
          }
          target={target}
        />
      ))}
      {recovery.recommendationsOpen ? (
        <p className="text-sm text-muted-foreground" role="status">
          {m.git_access_unsupported_ref_recommendations()}
        </p>
      ) : null}
      {recovery.primaryHasSettings ? (
        <Button
          className="self-start"
          type="button"
          size="sm"
          variant="ghost"
          onClick={recovery.openPrimarySettings}
        >
          {m.git_access_preflight_open_settings()}
        </Button>
      ) : null}
    </div>
  );
}

function RepositoryAccessTargetAlert({
  target,
}: {
  target: RepositoryAccessTargetView;
}) {
  const presentation = repositoryAccessPresentation(target.access);
  const destructive =
    presentation.status === "read_only" || presentation.status === "error";
  return (
    <Alert
      variant={destructive ? "destructive" : "default"}
      data-repository-access-blocker={
        target.access.snapshot?.repositoryId ?? "loading"
      }
      data-repository-access-status={presentation.status}
    >
      {statusIcon(presentation.status)}
      <AlertTitle className="min-w-0">
        <span className="block truncate" title={target.target.displayName}>
          {target.target.displayName}
        </span>
      </AlertTitle>
      <AlertDescription className="min-w-0">
        <span className="block break-all" title={target.target.displayPath}>
          {target.target.displayPath}
        </span>
        <span className="mt-1 block font-medium text-foreground">
          {presentation.title}
        </span>
        <span className="mt-1 block">{presentation.description}</span>
      </AlertDescription>
    </Alert>
  );
}

function statusIcon(
  status: ReturnType<typeof repositoryAccessPresentation>["status"],
) {
  if (status === "checking" || status === "loading") {
    return (
      <LoaderCircle
        className={status === "checking" ? "animate-spin" : undefined}
      />
    );
  }
  if (status === "read_only") return <LockKeyhole />;
  if (status === "error") return <AlertTriangle />;
  if (status === "local" || status === "writable") return <CheckCircle2 />;
  return <CircleHelp />;
}

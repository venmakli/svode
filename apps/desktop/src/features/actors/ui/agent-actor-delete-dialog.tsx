import { LoaderCircle } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  type RepositoryAccessPreflightController,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type {
  AgentActorDeleteReferenceState,
  AgentActorRow,
} from "../model/agent-actor-types";

export function AgentActorDeleteDialog({
  accessRecovery,
  actor,
  failure,
  pending,
  referenceState,
  onClose,
  onConfirm,
  onRetry,
}: {
  accessRecovery: RepositoryAccessPreflightController;
  actor: AgentActorRow | null;
  failure: string | null;
  pending: boolean;
  referenceState: AgentActorDeleteReferenceState;
  onClose(): void;
  onConfirm(): void;
  onRetry(): void;
}) {
  if (!actor) return null;
  const accessBlocked =
    accessRecovery.open &&
    accessRecovery.pending?.placement === "inline" &&
    accessRecovery.pending.intentKey === "agent-actor-delete-apply";
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (accessBlocked) {
            accessRecovery.close();
            return;
          }
          accessRecovery.close();
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.agent_actors_delete_title({ name: actor.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {m.agent_actors_delete_description({ owner: actor.ownerLabel })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {referenceState.phase === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {m.agent_actors_delete_scanning()}
          </p>
        ) : null}
        {referenceState.phase === "ready" &&
        referenceState.references.length > 0 ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">
              {m.agent_actors_delete_references_title()}
            </p>
            <ul className="max-h-36 list-disc space-y-1 overflow-y-auto pl-5 text-muted-foreground">
              {referenceState.references.map((reference) => (
                <li key={reference.path}>
                  {reference.title} · {ownerLabel(reference.ownerPath)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {referenceState.phase === "ready" &&
        referenceState.diagnostics.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {m.agent_actors_delete_reference_diagnostics({
              count: referenceState.diagnostics.length,
            })}
          </p>
        ) : null}
        {referenceState.phase === "error" ? (
          <div className="space-y-2 text-sm text-destructive">
            <p>{referenceState.message}</p>
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {m.agent_actors_delete_retry_scan()}
            </Button>
          </div>
        ) : null}
        {accessBlocked ? (
          <RepositoryAccessInlineRecovery recovery={accessRecovery} />
        ) : failure ? (
          <p className="text-sm text-destructive">{failure}</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={pending || (accessBlocked && accessRecovery.busy)}
            onClick={() => {
              if (accessBlocked) {
                accessRecovery.close();
                return;
              }
              accessRecovery.close();
              onClose();
            }}
          >
            {accessBlocked
              ? m.git_access_preflight_cancel()
              : m.agent_actors_cancel()}
          </AlertDialogCancel>
          {accessBlocked ? (
            <RepositoryAccessPrimaryButton recovery={accessRecovery} />
          ) : (
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={pending || referenceState.phase !== "ready"}
              onClick={onConfirm}
            >
              {pending ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {m.agent_actors_delete_confirm()}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ownerLabel(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

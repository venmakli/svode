import {
  AlertTriangle,
  CircleHelp,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";

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
import type { RepositoryAccessSnapshot } from "@/features/git";
import * as m from "@/paraglide/messages.js";

import type { ActorMutationIntent } from "../model/identity-mutation";
import {
  actorAccessPreflightCopy,
  type ActorAccessPreflightKind,
} from "./actor-access-preflight-copy";

export function ActorAccessPreflightDialog({
  error,
  intent,
  snapshot,
  verifying,
  onClose,
  onVerify,
}: {
  error: string | null;
  intent: ActorMutationIntent | null;
  snapshot: RepositoryAccessSnapshot | null;
  verifying: boolean;
  onClose(): void;
  onVerify(): void;
}) {
  if (!intent) return null;

  const status = verifying ? "checking" : (snapshot?.status ?? "unknown");
  const checking = status === "checking";
  const copy = actorAccessPreflightCopy({
    error,
    reason: snapshot?.reason ?? null,
    status,
  });
  const presentation = accessPresentation(copy.kind);
  const Icon = presentation.icon;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-actor-access-preflight
        data-actor-access-preflight-intent={intent.kind}
        data-actor-access-preflight-status={status}
      >
        <DialogHeader>
          <DialogTitle>{m.actors_access_preflight_title()}</DialogTitle>
          <DialogDescription>
            {m.actors_access_preflight_description({
              action: intentLabel(intent),
            })}
          </DialogDescription>
        </DialogHeader>

        <Alert variant={presentation.destructive ? "destructive" : "default"}>
          <Icon className={checking ? "animate-spin" : undefined} />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </Alert>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {m.actors_access_preflight_cancel()}
          </Button>
          <Button type="button" disabled={checking} onClick={onVerify}>
            {checking ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {checking
              ? m.actors_access_preflight_checking()
              : status === "unknown" && !error
                ? m.actors_access_check()
                : m.actors_access_retry()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function accessPresentation(kind: ActorAccessPreflightKind) {
  if (kind === "error") {
    return { destructive: true, icon: AlertTriangle };
  }
  if (kind === "checking") {
    return { destructive: false, icon: LoaderCircle };
  }
  if (kind === "read_only") {
    return { destructive: true, icon: LockKeyhole };
  }
  return { destructive: false, icon: CircleHelp };
}

function intentLabel(intent: ActorMutationIntent) {
  if (intent.kind === "add") return m.actors_add();
  if (intent.kind === "merge") return m.actors_merge();
  return m.actors_edit();
}

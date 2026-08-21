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

import {
  actorAccessPreflightActionLabel,
  actorAccessPreflightCopy,
  actorAccessPreflightStatus,
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
  intent: ActorAccessIntent | null;
  snapshot: RepositoryAccessSnapshot | null;
  verifying: boolean;
  onClose(): void;
  onVerify(): void;
}) {
  if (!intent) return null;

  const status = actorAccessPreflightStatus(snapshot, verifying);
  const checking = status === "checking";

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

        <ActorAccessPreflightAlert
          error={error}
          snapshot={snapshot}
          verifying={verifying}
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {m.actors_access_preflight_cancel()}
          </Button>
          <Button type="button" disabled={checking} onClick={onVerify}>
            {checking ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : null}
            {actorAccessPreflightActionLabel({ error, snapshot, verifying })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ActorAccessPreflightAlert({
  error,
  snapshot,
  verifying,
}: {
  error: string | null;
  snapshot: RepositoryAccessSnapshot | null;
  verifying: boolean;
}) {
  const status = actorAccessPreflightStatus(snapshot, verifying);
  const copy = actorAccessPreflightCopy({
    error,
    reason: snapshot?.reason ?? null,
    status,
  });
  const presentation = accessPresentation(copy.kind);
  const Icon = presentation.icon;
  return (
    <Alert
      data-actor-access-inline-status={status}
      variant={presentation.destructive ? "destructive" : "default"}
    >
      <Icon className={status === "checking" ? "animate-spin" : undefined} />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.description}</AlertDescription>
    </Alert>
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

type ActorAccessIntent = {
  kind:
    | "add"
    | "merge"
    | "edit"
    | "add-agent"
    | "edit-agent"
    | "delete-agent"
    | "save-agent-catalog";
};

function intentLabel(intent: ActorAccessIntent) {
  if (intent.kind === "add") return m.actors_add();
  if (intent.kind === "merge") return m.actors_merge();
  if (intent.kind === "add-agent") return m.agent_actors_add();
  if (intent.kind === "delete-agent") return m.agent_actors_delete();
  if (intent.kind === "save-agent-catalog")
    return m.agent_actors_save_catalog();
  if (intent.kind === "edit-agent") return m.agent_actors_edit();
  return m.actors_edit();
}

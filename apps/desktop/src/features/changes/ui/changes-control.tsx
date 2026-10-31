import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { refreshGitStatus, useGitStore } from "@/features/git";
import type { GitCommitRefusal } from "@/features/git/editor";
import { PeekCloseButton } from "@/shared/ui/peek-top-bar";
import * as m from "@/paraglide/messages.js";
import {
  inspectionPaths,
  resolveInspectionScope,
  type ChangesTarget,
} from "../model/scope";
import { createItemReader } from "../model/item-reader";
import { useSessionArea } from "../hooks/use-session-area";
import { sessionAreaPaths } from "../model/session-scope";
import { ChangesBody } from "./changes-body";
import { SessionChangesBody } from "./session-changes-body";
import { ChangesSaveFooter } from "./changes-save-footer";
import { changesCount } from "./changes-toolbar";
import { useChangesSave } from "../hooks/use-changes-save";
import { useCommitWithAgent } from "../hooks/use-commit-with-agent";
import type { AgentRequest } from "@/features/git";

export function ChangesControl({
  target,
  origin = "main",
}: {
  target: ChangesTarget;
  origin?: "main" | "peek";
}) {
  const scope = resolveInspectionScope(target);
  return (
    <ScopeChangesControl
      key={`${origin}:${scope.spacePath}`}
      target={target}
      origin={origin}
    />
  );
}

function ScopeChangesControl({
  target,
  origin,
}: {
  target: ChangesTarget;
  origin: "main" | "peek";
}) {
  const [open, setOpen] = useState(false);
  const status = useGitStore((state) => state.statuses[target.spacePath]);
  const { kind, sourceShape, spacePath, path } = target;
  const scope = useMemo(
    () => resolveInspectionScope({ kind, sourceShape, spacePath, path }),
    [kind, sourceShape, spacePath, path],
  );
  const area = useSessionArea(target);
  const paths = area
    ? sessionAreaPaths(area)
    : inspectionPaths(scope, status);
  const dirty = paths.length > 0;
  const statusError = useGitStore((state) =>
    Boolean(state.statusErrors[target.spacePath]),
  );
  const incomplete = area
    ? area.incomplete
    : status
      ? status.omittedFiles > 0
      : false;
  const count = changesCount(paths.length, incomplete);
  const read = area ? area.read : Boolean(status);
  // Quiet control: "no changes" is claimed only for a readable full status.
  const label = area
    ? dirty
      ? m.changes_session_label({ count })
      : read && !statusError && !incomplete
        ? m.changes_session_clean_label()
        : m.changes_session_title()
    : dirty
      ? m.changes_scope_label({ name: target.name, count })
      : read && !statusError && !incomplete
        ? m.changes_scope_clean_label({ name: target.name })
        : m.changes_scope_title({ name: target.name });
  useEffect(() => {
    void refreshGitStatus(target.spacePath);
  }, [target.spacePath]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              variant={origin === "peek" ? "ghost" : "outline"}
              size={dirty ? "sm" : "icon-sm"}
              className={dirty ? undefined : "text-muted-foreground"}
              data-changes-trigger
              data-changes-dirty={dirty}
              aria-label={label}
            >
              <FileDiff data-icon={dirty ? "inline-start" : undefined} />
              {dirty ? (
                <Badge variant="secondary" data-icon="inline-end">
                  {count}
                </Badge>
              ) : null}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <ChangesSheetContent
        target={target}
        origin={origin}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Sheet>
  );
}

/**
 * The "Changes" window of `target` opened from elsewhere than its control,
 * such as a file the agent changed in a chat turn (Stage 10 `08` R2).
 */
export function ChangesWindow({
  target,
  open,
  onOpenChange,
}: {
  target: ChangesTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (open) void refreshGitStatus(target.spacePath);
  }, [open, target.spacePath]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <ChangesSheetContent
        target={target}
        origin="main"
        open={open}
        onClose={() => onOpenChange(false)}
      />
    </Sheet>
  );
}

function ChangesSheetContent({
  target: requested,
  origin,
  open,
  onClose,
}: {
  target: ChangesTarget;
  origin: "main" | "peek";
  open: boolean;
  onClose: () => void;
}) {
  // A session's "Changes" lead to its Space; closing returns to the session.
  const [spaceShown, setSpaceShown] = useState(false);
  if (!open && spaceShown) setSpaceShown(false);
  const target =
    spaceShown && requested.kind === "session"
      ? sessionSpaceTarget(requested)
      : requested;
  const status = useGitStore((state) => state.statuses[target.spacePath]);
  const { kind, sourceShape, spacePath, path } = target;
  const scope = useMemo(
    () => resolveInspectionScope({ kind, sourceShape, spacePath, path }),
    [kind, sourceShape, spacePath, path],
  );
  const area = useSessionArea(target, false);
  const paths = area
    ? sessionAreaPaths(area)
    : inspectionPaths(scope, status);
  const dirty = paths.length > 0;
  const statusError = useGitStore(
    (state) => state.statusErrors[target.spacePath],
  );
  const reader = useMemo(() => createItemReader(), []);
  const save = useChangesSave(target, open);
  // The version choice opens once "Changes" has closed and let go of focus.
  const versionChoiceRef = useRef<GitCommitRefusal | null>(null);
  // So does the composer that takes «Зафиксировать с агентом» (1.10).
  const agent = useCommitWithAgent(target, open);
  const agentRequestRef = useRef<AgentRequest | null>(null);

  return (
    <SheetContent
      side="right"
      showCloseButton={false}
      className="data-[side=right]:gap-0 data-[side=right]:overflow-hidden data-[side=right]:rounded-xl data-[side=right]:border"
      style={{
        bottom: "0.75rem",
        height: "auto",
        maxWidth: "none",
        right: "0.75rem",
        top: "0.75rem",
        width:
          origin === "peek"
            ? "min(26rem, calc(100vw - 1.5rem))"
            : "min(30rem, calc(100vw - 1.5rem))",
      }}
      overlayClassName={
        origin === "peek"
          ? "bg-transparent backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
          : undefined
      }
      onCloseAutoFocus={(event) => {
        const request = agentRequestRef.current;
        if (request) {
          agentRequestRef.current = null;
          event.preventDefault();
          agent.deliver(request);
          return;
        }
        const refusal = versionChoiceRef.current;
        if (!refusal) return;
        versionChoiceRef.current = null;
        event.preventDefault();
        refusal.chooseVersion();
      }}
    >
      {area ? (
        <SessionChangesBody
          open={open}
          target={target}
          area={area}
          reader={reader}
          onShowSpace={() => setSpaceShown(true)}
        />
      ) : (
        <ChangesBody
          key={`${scope.kind}:${scope.path}`}
          open={open}
          scope={scope}
          status={status}
          error={statusError}
          paths={paths}
          reader={reader}
          name={target.name}
        />
      )}
      <ChangesSaveFooter
        save={save}
        dirty={dirty}
        statusError={Boolean(statusError)}
        fileScope={scope.kind === "file"}
        onChooseVersion={(refusal) => {
          versionChoiceRef.current = refusal;
          onClose();
        }}
        agent={{
          available: agent.available,
          preparing: agent.preparing,
          onCommit: () => {
            void agent.prepare().then((request) => {
              if (!request) return;
              agentRequestRef.current = request;
              onClose();
            });
          },
        }}
      />
      <div className="absolute top-3 right-3">
        <PeekCloseButton onClick={onClose} />
      </div>
    </SheetContent>
  );
}

/** The Space a session works in, as its own "Changes" show it. */
function sessionSpaceTarget(target: ChangesTarget): ChangesTarget {
  return {
    kind: target.work?.spaceKind ?? "space",
    sourceShape: "directory",
    spacePath: target.spacePath,
    projectPath: target.projectPath,
    path: "",
    name: target.name,
  };
}

import { useEffect, useMemo, useState } from "react";
import { FileDiff, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RepositoryAccessInlineRecovery,
  RepositoryAccessPrimaryButton,
  refreshGitStatus,
  repositoryAccessPresentation,
  useGitStore,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import {
  inspectionPaths,
  resolveInspectionScope,
  type ChangesTarget,
} from "../model/scope";
import { createItemReader } from "../model/item-reader";
import { ChangesBody } from "./changes-body";
import { useChangesSave } from "../hooks/use-changes-save";

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
  const paths = inspectionPaths(scope, status);
  const dirty = paths.length > 0;
  const statusError = useGitStore(
    (state) => state.statusErrors[target.spacePath] ?? false,
  );
  const reader = useMemo(() => createItemReader(), []);
  const save = useChangesSave(target, open);
  const hint =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? scope.kind === "file"
        ? "⌘S"
        : "⇧⌘S"
      : scope.kind === "file"
        ? "Ctrl+S"
        : "Ctrl+Shift+S";
  const label = m.changes_scope_label({
    name: target.name,
    count: String(paths.length),
  });
  useEffect(() => {
    void refreshGitStatus(target.spacePath);
  }, [target.spacePath]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-changes-trigger
              aria-label={label}
            >
              <FileDiff data-icon="inline-start" />
              <span className="hidden lg:inline">{m.changes_title()}</span>
              {dirty ? <Badge variant="secondary">{paths.length}</Badge> : null}
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <SheetContent
        side="right"
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
      >
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle>{m.changes_title()}</SheetTitle>
          <SheetDescription className="truncate">
            {target.name}
          </SheetDescription>
          {scope.path ? (
            <p className="truncate text-xs text-muted-foreground">
              {scope.path}
            </p>
          ) : null}
        </SheetHeader>
        {open ? (
          <ChangesBody
            key={`${scope.kind}:${scope.path}`}
            scope={scope}
            status={status}
            error={statusError}
            paths={paths}
            reader={reader}
            name={target.name}
          />
        ) : null}
        {dirty || save.error || save.saving ? (
          <SheetFooter className="shrink-0 border-t">
            {save.error ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {save.error === "partial"
                    ? m.changes_partial()
                    : m.changes_save_failed()}
                </AlertDescription>
              </Alert>
            ) : null}
            {!save.editable ? (
              <p className="text-sm text-muted-foreground">
                {save.access.loading || save.access.verifying
                  ? m.changes_access_pending()
                  : repositoryAccessPresentation(save.access).description}
              </p>
            ) : null}
            <RepositoryAccessInlineRecovery recovery={save.recovery} />
            <RepositoryAccessPrimaryButton recovery={save.recovery} />
            <Button
              disabled={!save.editable || save.saving || statusError}
              onClick={() => void save.save(scope.kind !== "file")}
            >
              {save.saving ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              {m.changes_save()}
              <span className="ml-auto">{hint}</span>
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

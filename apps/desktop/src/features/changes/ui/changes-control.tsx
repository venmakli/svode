import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { FileDiff, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useWorkingTreeItem } from "../hooks/use-working-tree-item";
import { useChangesSave } from "../hooks/use-changes-save";

const TextDiff = lazy(() =>
  import("./text-diff").then((module) => ({ default: module.TextDiff })),
);

export function ChangesControl({
  target,
  origin = "main",
}: {
  target: ChangesTarget;
  origin?: "main" | "peek";
}) {
  const scope = resolveInspectionScope(target);
  if (scope.kind !== "file") return null;
  return (
    <ExactChangesControl
      key={`${origin}:${scope.spacePath}`}
      target={target}
      origin={origin}
    />
  );
}

function ExactChangesControl({
  target,
  origin,
}: {
  target: ChangesTarget;
  origin: "main" | "peek";
}) {
  const [open, setOpen] = useState(false);
  const status = useGitStore((state) => state.statuses[target.spacePath]);
  const scope = useMemo(() => resolveInspectionScope(target), [target]);
  const paths = inspectionPaths(scope, status);
  const dirty = paths.length > 0;
  const conflict =
    status?.files.some(
      (file) => file.path === target.path && file.state === "conflict",
    ) ?? false;
  const patch = useWorkingTreeItem(
    target.spacePath,
    target.path,
    status,
    open && dirty && !conflict,
  );
  const save = useChangesSave(target, open);
  const hint =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "⌘S"
      : "Ctrl+S";
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
        className="gap-0 data-[side=right]:sm:max-w-none"
        style={{
          width: origin === "peek" ? "min(600px, 88vw)" : "min(720px, 94vw)",
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
          <p className="truncate text-xs text-muted-foreground">
            {target.path}
          </p>
        </SheetHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          data-changes-body
        >
          {!status ? (
            <Skeleton className="m-4 h-32" />
          ) : !dirty ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{m.changes_clean()}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : conflict ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{m.changes_conflict()}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : patch.error ? (
            <Alert>
              <AlertDescription>{m.changes_load_failed()}</AlertDescription>
              <Button variant="outline" onClick={patch.retry}>
                {m.changes_retry()}
              </Button>
            </Alert>
          ) : !patch.item ? (
            <Skeleton className="m-4 h-32" />
          ) : patch.item.state === "text" ? (
            <Suspense fallback={<Skeleton className="m-4 h-32" />}>
              <TextDiff item={patch.item} />
            </Suspense>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {patch.item.state === "no_content_diff"
                    ? m.changes_index_only()
                    : patch.item.state === "truncated"
                      ? m.changes_truncated()
                      : m.changes_not_text()}
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        {dirty || save.error ? (
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
              disabled={!save.editable || save.saving}
              onClick={() => void save.save()}
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

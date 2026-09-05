import { lazy, Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AccordionItem,
  AccordionContent,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileGitState, GitStatus } from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { useWorkingTreeItem } from "../hooks/use-working-tree-item";
import type { InspectionScope } from "../model/scope";
import type { ItemReader } from "../model/item-reader";

const TextDiff = lazy(() =>
  import("./text-diff").then((module) => ({ default: module.TextDiff })),
);

export function ChangedItem({
  scope,
  path,
  name,
  state,
  status,
  expanded,
  reader,
  exact = false,
}: {
  scope: InspectionScope;
  path: string;
  name: string;
  state: FileGitState;
  status: GitStatus;
  expanded: boolean;
  reader: ItemReader;
  exact?: boolean;
}) {
  const patch = useWorkingTreeItem(
    reader,
    scope,
    path,
    status,
    expanded && state !== "conflict",
  );
  const item = patch.item;
  const stats = item?.diff?.hunks.reduce(
    (total, hunk) => ({
      additions: total.additions + hunk.additionLines,
      deletions: total.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
  const content = (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={patch.updating}>
      {patch.updating && item ? (
        <p role="status" className="px-4 text-xs text-muted-foreground">
          {m.changes_updating()}
        </p>
      ) : null}
      {state === "conflict" ? (
        <ItemMessage>{m.changes_conflict()}</ItemMessage>
      ) : patch.error ? (
        <Alert>
          <AlertDescription>{m.changes_load_failed()}</AlertDescription>
          <Button variant="outline" onClick={patch.retry}>
            {m.changes_retry()}
          </Button>
        </Alert>
      ) : !item ? (
        <Skeleton className="m-4 h-32" />
      ) : (
        <>
          {item.previousPath ? (
            <p className="break-words px-4 text-xs text-muted-foreground">
              {m.changes_renamed({ path: item.previousPath })}
            </p>
          ) : null}
          {item.state === "text" ? (
            <Suspense fallback={<Skeleton className="m-4 h-32" />}>
              <TextDiff item={item} />
            </Suspense>
          ) : (
            <ItemMessage>
              {itemMessage(item.state, item.budgetLimited)}
            </ItemMessage>
          )}
          {item.state === "binary" || item.state === "invalid_encoding" ? (
            <p className="px-4 text-xs text-muted-foreground">
              {m.changes_bytes({
                before: String(item.beforeBytes ?? 0),
                after: String(item.afterBytes ?? 0),
              })}
            </p>
          ) : null}
          {item.budgetLimited ? (
            <Button variant="outline" onClick={patch.retry}>
              {m.changes_retry()}
            </Button>
          ) : null}
        </>
      )}
      {state !== "deleted" &&
      item?.state !== "disappeared" &&
      item?.state !== "gitlink" &&
      item?.state !== "metadata" &&
      (state === "conflict" ||
        patch.error ||
        (item && item.state !== "text" && item.state !== "no_content_diff")) ? (
        <div className="px-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void patch.reveal()}
          >
            {m.changes_reveal()}
          </Button>
        </div>
      ) : null}
      {patch.sourceError ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {m.changes_reveal_failed()}
        </p>
      ) : null}
    </div>
  );
  if (exact) return content;
  return (
    <AccordionItem value={path} data-changes-item={path}>
      <div className="sticky top-0 z-10 bg-background">
        <AccordionTrigger
          data-changes-item-trigger={path}
          className="min-w-0 gap-2 px-4"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate">{item?.title || name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {path}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant="secondary">{stateLabel(state)}</Badge>
            {stats ? (
              <span className="text-xs font-normal text-muted-foreground">
                {m.changes_stats({
                  added: String(stats.additions),
                  removed: String(stats.deletions),
                })}
              </span>
            ) : null}
          </span>
        </AccordionTrigger>
      </div>
      <AccordionContent className="h-auto">
        {expanded ? content : null}
      </AccordionContent>
    </AccordionItem>
  );
}

function ItemMessage({ children }: { children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function stateLabel(state: FileGitState) {
  switch (state) {
    case "modified":
      return m.changes_modified();
    case "deleted":
      return m.changes_deleted();
    case "untracked":
      return m.changes_added();
    case "conflict":
      return m.changes_conflict_label();
  }
}

function itemMessage(
  state: NonNullable<ReturnType<typeof useWorkingTreeItem>["item"]>["state"],
  budgetLimited?: boolean,
) {
  switch (state) {
    case "no_content_diff":
      return m.changes_index_only();
    case "truncated":
      return budgetLimited ? m.changes_budget_limit() : m.changes_truncated();
    case "invalid_encoding":
      return m.changes_invalid_encoding();
    case "disappeared":
      return m.changes_disappeared();
    case "gitlink":
      return m.changes_gitlink();
    case "metadata":
      return m.changes_metadata();
    case "conflict":
      return m.changes_conflict();
    default:
      return m.changes_not_text();
  }
}

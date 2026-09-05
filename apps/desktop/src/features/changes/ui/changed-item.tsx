import { lazy, Suspense } from "react";
import { AccordionItem, AccordionContent } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileGitState, GitStatus } from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { useWorkingTreeItem } from "../hooks/use-working-tree-item";
import type { InspectionScope } from "../model/scope";
import type { ItemReader } from "../model/item-reader";
import type { InspectionItemStats } from "../api/inspection";
import { ChangedItemHeader } from "./changed-item-header";

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
  stats,
}: {
  scope: InspectionScope;
  path: string;
  name: string;
  state: FileGitState;
  status: GitStatus;
  expanded: boolean;
  reader: ItemReader;
  exact?: boolean;
  stats?: InspectionItemStats;
}) {
  const patch = useWorkingTreeItem(
    reader,
    scope,
    path,
    status,
    expanded && state !== "conflict",
  );
  const item = patch.item;
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
        <ChangedItemHeader
          path={path}
          name={item?.title || name}
          state={state}
          stats={stats}
        />
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

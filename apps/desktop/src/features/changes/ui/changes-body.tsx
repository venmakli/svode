import { useRef, useState } from "react";
import { Accordion } from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { refreshGitStatus, type GitStatus } from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { useChangesItemNames } from "../hooks/use-changes-item-names";
import { useChangesAccordion } from "../hooks/use-changes-accordion";
import { useChangesStats } from "../hooks/use-changes-stats";
import type { ItemReader } from "../model/item-reader";
import type { InspectionScope } from "../model/scope";
import {
  filterChanges,
  summarizeChanges,
  type ChangesFilter,
} from "../model/list-summary";
import { ChangedItem } from "./changed-item";
import { ChangesToolbar } from "./changes-toolbar";

export function ChangesBody({
  scope,
  status,
  error,
  paths,
  reader,
  name,
}: {
  scope: InspectionScope;
  status?: GitStatus;
  error: boolean;
  paths: string[];
  reader: ItemReader;
  name: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<ChangesFilter>("all");
  const names = useChangesItemNames(scope.spacePath);
  const files = new Map(status?.files.map((file) => [file.path, file]));
  const filtered = filterChanges(paths, files, filter);
  const accordion = useChangesAccordion(paths, body, filtered.paths);
  const stats = useChangesStats(scope, status, paths);
  return (
    <>
      {scope.kind !== "file" && status && !error ? (
        <ChangesToolbar
          filter={filter}
          onFilterChange={(next) => {
            setFilter(next);
            if (body.current) body.current.scrollTop = 0;
          }}
          counts={filtered.counts}
          summary={summarizeChanges(filtered.paths, stats)}
        />
      ) : null}
      <div
        ref={body}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        data-changes-body
        onFocusCapture={(event) =>
          accordion.onFocus(event.target as HTMLElement)
        }
        onBlurCapture={(event) => accordion.onBlur(event.relatedTarget)}
      >
        {error ? (
          <Alert>
            <AlertDescription>{m.changes_repository_failed()}</AlertDescription>
            <Button
              variant="outline"
              onClick={() => void refreshGitStatus(scope.spacePath)}
            >
              {m.changes_retry()}
            </Button>
          </Alert>
        ) : null}
        {!status ? (
          error ? null : (
            <Skeleton className="m-4 h-32" />
          )
        ) : paths.length === 0 ? (
          error ? null : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{m.changes_clean()}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )
        ) : scope.kind === "file" ? (
          <ChangedItem
            exact
            reader={reader}
            scope={scope}
            path={paths[0]}
            name={name}
            state={files.get(paths[0])!.state}
            status={status}
            expanded
          />
        ) : (
          <>
            {filtered.paths.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{m.changes_filter_empty()}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : null}
            <Accordion
              type="multiple"
              value={accordion.expanded}
              onValueChange={accordion.setExpanded}
              className="px-4"
            >
              {accordion.shown.map((path) => (
                <ChangedItem
                  key={path}
                  reader={reader}
                  scope={scope}
                  path={path}
                  name={names.get(path) || itemName(path, scope, name)}
                  state={files.get(path)!.state}
                  status={status}
                  expanded={accordion.expanded.includes(path)}
                  stats={stats[path]}
                />
              ))}
            </Accordion>
            {accordion.remaining > 0 ? (
              <div className="p-4">
                <Button variant="outline" onClick={accordion.more}>
                  {m.changes_more({ count: String(accordion.remaining) })}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function itemName(path: string, scope: InspectionScope, ownerName: string) {
  const parts = path.split("/");
  const file = parts.at(-1) ?? path;
  if (file.toLowerCase() === "readme.md")
    return parts.slice(0, -1).join("/") === scope.path
      ? ownerName
      : (parts.at(-2) ?? ownerName);
  return file.endsWith(".md") ? file.slice(0, -3).replaceAll("-", " ") : file;
}

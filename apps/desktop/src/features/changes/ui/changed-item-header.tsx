import { AccordionTrigger } from "@/components/ui/accordion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileGitState } from "@/features/git";
import * as m from "@/paraglide/messages.js";
import type { InspectionItemStats } from "../api/inspection";
import { ChangeStateIcon } from "./change-state-icon";

export function ChangedItemHeader({
  path,
  name,
  state,
  stats,
}: {
  path: string;
  name: string;
  state: FileGitState;
  stats?: InspectionItemStats;
}) {
  const label = stateLabel(state);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <AccordionTrigger
          className="min-w-0 items-center gap-2 py-1.5 hover:no-underline"
          data-changes-item-trigger={path}
          aria-label={`${name} — ${label} (${path})`}
        >
          <ChangeStateIcon state={state} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {stats === undefined ? (
            <Skeleton className="h-3 w-12" />
          ) : stats.additions !== null && stats.deletions !== null ? (
            <span
              className="flex shrink-0 items-center gap-2 font-mono text-xs font-normal tabular-nums"
              data-changes-stats
              aria-label={m.changes_stats({
                added: String(stats.additions),
                removed: String(stats.deletions),
              })}
            >
              <span className="text-destructive">−{stats.deletions}</span>
              <span className="text-[var(--property-green)]">
                +{stats.additions}
              </span>
            </span>
          ) : state === "conflict" ? (
            <span className="shrink-0 text-xs text-destructive">{label}</span>
          ) : null}
        </AccordionTrigger>
      </TooltipTrigger>
      <TooltipContent className="break-all">
        {path} — {label}
      </TooltipContent>
    </Tooltip>
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

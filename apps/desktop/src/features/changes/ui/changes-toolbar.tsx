import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import type { ChangesFilter, summarizeChanges } from "../model/list-summary";
import { ChangeStateIcon } from "./change-state-icon";

export function ChangesToolbar({
  filter,
  onFilterChange,
  counts,
  summary,
}: {
  filter: ChangesFilter;
  onFilterChange: (filter: ChangesFilter) => void;
  counts: Record<ChangesFilter, number>;
  summary: ReturnType<typeof summarizeChanges>;
}) {
  const labels = {
    all: m.changes_filter_all(),
    modified: m.changes_filter_modified(),
    deleted: m.changes_filter_deleted(),
    untracked: m.changes_filter_added(),
    conflict: m.changes_filter_conflict(),
  };
  const filters: ChangesFilter[] = ["all", "modified", "deleted", "untracked"];
  if (counts.conflict > 0 || filter === "conflict") filters.push("conflict");
  const partial = summary.counted < summary.total;
  const statsLabel = m.changes_stats({
    added: String(summary.additions),
    removed: String(summary.deletions),
  });
  const coverage = m.changes_stats_coverage({
    count: String(summary.counted),
    total: String(summary.total),
  });
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-3 px-4 pb-2"
      data-changes-toolbar
    >
      <Select
        value={filter}
        onValueChange={(value) => {
          const next = filters.find((item) => item === value);
          if (next) onFilterChange(next);
        }}
      >
        <SelectTrigger size="sm" aria-label={m.changes_filter_label()}>
          <SelectValue>
            <ChangeStateIcon state={filter} />
            {labels[filter]} · {counts[filter]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectGroup>
            {filters.map((value) => (
              <SelectItem key={value} value={value} textValue={labels[value]}>
                <ChangeStateIcon state={value} />
                {labels[value]} · {counts[value]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {summary.pending > 0 ? (
        <span role="status" aria-label={m.changes_stats_loading()}>
          <Skeleton className="h-4 w-20" />
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="flex items-center gap-2 text-sm"
              data-changes-summary
              aria-label={
                summary.counted === 0 && summary.total > 0
                  ? m.changes_stats_unavailable()
                  : partial
                    ? `${statsLabel}. ${coverage}`
                    : statsLabel
              }
            >
              {summary.counted > 0 || summary.total === 0 ? (
                <>
                  <span className="font-mono text-destructive tabular-nums">
                    −{summary.deletions}
                  </span>
                  <span className="font-mono text-[var(--property-green)] tabular-nums">
                    +{summary.additions}
                  </span>
                  {partial ? (
                    <span className="text-muted-foreground">*</span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {m.changes_stats_unavailable()}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent>{partial ? coverage : statsLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

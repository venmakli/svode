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

const filterLabels = (): Record<ChangesFilter, string> => ({
  all: m.changes_filter_all(),
  modified: m.changes_filter_modified(),
  deleted: m.changes_filter_deleted(),
  untracked: m.changes_filter_added(),
  conflict: m.changes_filter_conflict(),
});

export function ChangesFilterSelect({
  filter,
  onFilterChange,
  counts,
  className,
}: {
  filter: ChangesFilter;
  onFilterChange: (filter: ChangesFilter) => void;
  counts: Record<ChangesFilter, number>;
  className?: string;
}) {
  const labels = filterLabels();
  const filters: ChangesFilter[] = ["all", "modified", "deleted", "untracked"];
  if (counts.conflict > 0 || filter === "conflict") filters.push("conflict");
  return (
    <Select
      value={filter}
      onValueChange={(value) => {
        const next = filters.find((item) => item === value);
        if (next) onFilterChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        className={className}
        aria-label={m.changes_filter_label()}
      >
        <SelectValue>
          <ChangeStateIcon state={filter} />
          {labels[filter]} · {counts[filter]}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end">
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
  );
}

export function ChangesSummary({
  summary,
}: {
  summary: ReturnType<typeof summarizeChanges>;
}) {
  const partial = summary.counted < summary.total;
  const statsLabel = m.changes_stats({
    added: String(summary.additions),
    removed: String(summary.deletions),
  });
  const coverage = m.changes_stats_coverage({
    count: String(summary.counted),
    total: String(summary.total),
  });
  if (summary.pending > 0)
    return (
      <span role="status" aria-label={m.changes_stats_loading()}>
        <Skeleton className="h-4 w-20" />
      </span>
    );
  return (
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
  );
}

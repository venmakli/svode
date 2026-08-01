import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import { useActorActivity } from "../hooks/use-actor-activity";
import {
  actorActivityEndDate,
  buildActorHeatmapCells,
  type ActorHeatmapCell,
} from "../model/actor-values";

export function ActorActivityHeatmap({
  canonicalEmail,
  spacePath,
}: {
  canonicalEmail: string;
  spacePath: string;
}) {
  const state = useActorActivity(spacePath, canonicalEmail);

  if (state.phase === "initial") {
    return (
      <div
        className="flex flex-col gap-2"
        aria-label={m.actors_activity_loading()}
      >
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <Alert variant="destructive" title={state.error}>
        <AlertCircle />
        <AlertDescription>{m.actors_activity_error()}</AlertDescription>
      </Alert>
    );
  }

  const cells = buildActorHeatmapCells(state.snapshot);
  const weekCount = Math.ceil(cells.length / 7);
  const totalCommits = state.snapshot.days.reduce(
    (total, day) => total + day.commitCount,
    0,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {m.actors_activity_range({
            endDate: actorActivityEndDate(state.snapshot),
            startDate: state.snapshot.rangeStart,
          })}
        </span>
        {totalCommits === 0 ? <span>{m.actors_activity_empty()}</span> : null}
      </div>
      <div className="min-w-0 pb-2">
        <TooltipProvider delayDuration={100}>
          <div
            className="grid w-full min-w-0 grid-flow-col grid-rows-7 gap-0.5"
            style={{
              gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))`,
            }}
            role="img"
            aria-label={m.actors_activity()}
            data-actor-activity-heatmap
            data-activity-weeks={weekCount}
          >
            {cells.map((cell, index) =>
              cell ? (
                <HeatmapDay key={cell.date} cell={cell} />
              ) : (
                <span
                  key={`padding-${index}`}
                  className="aspect-square w-full min-w-0"
                  aria-hidden
                />
              ),
            )}
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}

function HeatmapDay({ cell }: { cell: ActorHeatmapCell }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "aspect-square w-full min-w-0 rounded-[1px]",
            cell.level === 0 && "bg-muted",
            cell.level === 1 && "bg-primary/20",
            cell.level === 2 && "bg-primary/40",
            cell.level === 3 && "bg-primary/70",
            cell.level === 4 && "bg-primary",
          )}
          data-activity-date={cell.date}
          data-activity-count={cell.commitCount}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent>
        {m.actors_activity_day({
          count: String(cell.commitCount),
          date: cell.date,
        })}
      </TooltipContent>
    </Tooltip>
  );
}

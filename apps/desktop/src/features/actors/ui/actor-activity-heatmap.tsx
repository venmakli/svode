import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";

import {
  buildActorHeatmapCells,
  type ActorHeatmapCell,
} from "../model/actor-values";
import type { ActorActivitySnapshot } from "../model/types";

export function ActorActivityHeatmap({
  activity,
  onSelectDay,
  selectedDay,
}: {
  activity: ActorActivitySnapshot;
  onSelectDay: (day: string) => void;
  selectedDay: string | null;
}) {
  const cells = buildActorHeatmapCells(activity);
  const weekCount = Math.ceil(cells.length / 7);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <TooltipProvider delayDuration={100}>
          <div
            className="grid min-w-[22rem] grid-flow-col grid-rows-7 gap-0.5"
            style={{
              gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))`,
            }}
            role="group"
            aria-label={m.actors_activity()}
            data-actor-activity-heatmap
            data-activity-weeks={weekCount}
          >
            {cells.map((cell, index) =>
              cell ? (
                <HeatmapDay
                  key={cell.date}
                  cell={cell}
                  onSelect={onSelectDay}
                  selected={selectedDay === cell.date}
                />
              ) : (
                <span
                  key={`padding-${index}`}
                  className="aspect-square w-full min-w-1"
                  aria-hidden
                />
              ),
            )}
          </div>
        </TooltipProvider>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {m.actors_activity_total({
            count: String(activity.commitCount),
          })}
        </span>
        <div
          className="flex items-center gap-1.5"
          aria-label={m.actors_activity_legend()}
        >
          <span>{m.actors_activity_less()}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className={cn("size-2.5 rounded-[2px]", heatmapLevelClass(level))}
              aria-hidden
            />
          ))}
          <span>{m.actors_activity_more()}</span>
        </div>
      </div>
    </div>
  );
}

function HeatmapDay({
  cell,
  onSelect,
  selected,
}: {
  cell: ActorHeatmapCell;
  onSelect: (day: string) => void;
  selected: boolean;
}) {
  const label = m.actors_activity_day({
    count: String(cell.commitCount),
    date: cell.date,
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "aspect-square w-full min-w-1 rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            heatmapLevelClass(cell.level),
            selected && "ring-2 ring-foreground ring-offset-1",
          )}
          aria-label={label}
          aria-pressed={selected}
          data-activity-date={cell.date}
          data-activity-count={cell.commitCount}
          onClick={() => onSelect(cell.date)}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function heatmapLevelClass(level: number) {
  if (level === 1) return "bg-primary/20";
  if (level === 2) return "bg-primary/40";
  if (level === 3) return "bg-primary/70";
  if (level === 4) return "bg-primary";
  return "bg-muted";
}

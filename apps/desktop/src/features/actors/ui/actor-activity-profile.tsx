import {
  AlertCircle,
  GitCommitHorizontal,
  LoaderCircle,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as m from "@/paraglide/messages.js";

import {
  type ActorActivityResource,
  useActorActivity,
} from "../hooks/use-actor-activity";
import type { ActorCatalogRow } from "../model/types";
import { ActorActivityHeatmap } from "./actor-activity-heatmap";
import { ActorActivityTimeline } from "./actor-activity-timeline";

export function ActorActivityProfile({
  actor,
  spacePath,
}: {
  actor: ActorCatalogRow;
  spacePath: string;
}) {
  const activity = useActorActivity({
    availableYears: actor.availableYears,
    canonicalEmail: actor.canonicalEmail,
    spacePath,
  });
  const years =
    actor.availableYears.length > 0
      ? actor.availableYears
      : [activity.selectedYear];

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{m.actors_activity()}</h3>
        <YearNavigation
          onSelect={activity.selectYear}
          selectedYear={activity.selectedYear}
          years={years}
        />
      </div>

      <YearActivity
        onRetry={activity.retryYear}
        onSelectDay={activity.selectDay}
        resource={activity.yearResource}
        selectedDay={activity.selectedDay}
      />

      {activity.yearResource.phase === "ready" ? (
        <TimelineActivity
          loadMore={activity.loadMore}
          onResetDay={activity.resetDay}
          onRetry={activity.retryTimeline}
          resource={activity.timelineResource}
          selectedDay={activity.selectedDay}
        />
      ) : null}
    </section>
  );
}

function YearNavigation({
  onSelect,
  selectedYear,
  years,
}: {
  onSelect: (year: number) => void;
  selectedYear: number;
  years: readonly number[];
}) {
  if (years.length <= 1) {
    return (
      <span className="text-xs tabular-nums text-muted-foreground">
        {selectedYear}
      </span>
    );
  }
  return (
    <div className="max-w-[70%] overflow-x-auto">
      <ToggleGroup
        type="single"
        aria-label={m.actors_activity_years()}
        className="min-w-max"
        size="sm"
        value={String(selectedYear)}
        variant="outline"
        onValueChange={(value) => {
          if (value) onSelect(Number(value));
        }}
      >
        {years.map((year) => (
          <ToggleGroupItem
            aria-label={String(year)}
            key={year}
            value={String(year)}
          >
            {year}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function YearActivity({
  onRetry,
  onSelectDay,
  resource,
  selectedDay,
}: {
  onRetry: () => void;
  onSelectDay: (day: string) => void;
  resource: ActorActivityResource;
  selectedDay: string | null;
}) {
  if (resource.phase === "initial" || resource.phase === "loading") {
    return <ActivitySkeleton includeTimeline={false} />;
  }
  if (resource.phase === "error") {
    return <ActivityError error={resource.error} onRetry={onRetry} />;
  }
  return (
    <ActorActivityHeatmap
      activity={resource.snapshot}
      onSelectDay={onSelectDay}
      selectedDay={selectedDay}
    />
  );
}

function TimelineActivity({
  loadMore,
  onResetDay,
  onRetry,
  resource,
  selectedDay,
}: {
  loadMore: () => void;
  onResetDay: () => void;
  onRetry: () => void;
  resource: ActorActivityResource;
  selectedDay: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">
          {selectedDay
            ? m.actors_activity_day_filter({ date: selectedDay })
            : m.actors_activity_timeline()}
        </h4>
        {selectedDay ? (
          <Button size="xs" type="button" variant="ghost" onClick={onResetDay}>
            <X data-icon="inline-start" />
            {m.actors_activity_reset_day()}
          </Button>
        ) : null}
      </div>

      {resource.phase === "initial" || resource.phase === "loading" ? (
        <ActivitySkeleton includeTimeline />
      ) : resource.phase === "error" ? (
        <ActivityError
          error={resource.error}
          onRetry={onRetry}
          secondaryAction={
            selectedDay ? (
              <Button
                size="xs"
                type="button"
                variant="ghost"
                onClick={onResetDay}
              >
                {m.actors_activity_reset_day()}
              </Button>
            ) : null
          }
        />
      ) : resource.snapshot.timeline.months.length === 0 ? (
        <Empty className="min-h-36 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitCommitHorizontal />
            </EmptyMedia>
            <EmptyTitle>{m.actors_activity_empty()}</EmptyTitle>
            <EmptyDescription>
              {m.actors_activity_timeline_empty()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ActorActivityTimeline activity={resource.snapshot} />
          {resource.loadMoreError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{resource.loadMoreError}</AlertDescription>
            </Alert>
          ) : null}
          {resource.snapshot.timeline.nextCursor ? (
            <Button
              className="self-start"
              disabled={resource.loadingMore}
              size="sm"
              type="button"
              variant="outline"
              onClick={loadMore}
            >
              {resource.loadingMore ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              {resource.loadingMore
                ? m.actors_activity_loading_more()
                : resource.loadMoreError
                  ? m.actors_activity_retry()
                  : m.actors_activity_load_more()}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function ActivitySkeleton({ includeTimeline }: { includeTimeline: boolean }) {
  return (
    <div
      className="flex flex-col gap-2"
      aria-label={m.actors_activity_loading()}
    >
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-24 w-full" />
      {includeTimeline ? <Skeleton className="h-28 w-full" /> : null}
    </div>
  );
}

function ActivityError({
  error,
  onRetry,
  secondaryAction,
}: {
  error: string;
  onRetry: () => void;
  secondaryAction?: React.ReactNode;
}) {
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{m.actors_activity_error()}</AlertTitle>
      <AlertDescription title={error}>{error}</AlertDescription>
      <div className="col-span-full mt-2 flex gap-1">
        {secondaryAction}
        <Button size="xs" type="button" variant="outline" onClick={onRetry}>
          {m.actors_activity_retry()}
        </Button>
      </div>
    </Alert>
  );
}

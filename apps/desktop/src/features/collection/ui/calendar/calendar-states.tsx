import { CalendarDays, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import * as m from "@/paraglide/messages.js";

export function NoDateFieldState({
  loading,
  onAddDateColumn,
}: {
  loading: boolean;
  onAddDateColumn: () => void;
}) {
  if (loading) return <CalendarLoadingState />;
  return (
    <div className={detailPageViewClassName}>
      <Empty className="min-h-56 flex-none rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CalendarDays />
          </EmptyMedia>
          <EmptyTitle>{m.calendar_no_date_field_title()}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="sm" onClick={onAddDateColumn}>
            <Plus data-icon="inline-start" />
            {m.collection_add_date_property()}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

export function CalendarLoadingState() {
  return (
    <div className={`${detailPageViewClassName} gap-2`}>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-16" />
        </div>
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="min-h-[520px] rounded-lg" />
    </div>
  );
}

export function CalendarEmptyOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="rounded-lg border bg-background/90 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
        {m.calendar_empty_period()}
      </div>
    </div>
  );
}

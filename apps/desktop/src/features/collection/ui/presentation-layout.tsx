import type { ComponentProps, CSSProperties } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/lib/utils";
import type { CollectionGalleryCardDensity } from "../model/presentation-layout";

const collectionCardGap = 14;

export function CollectionListShell({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10",
        className,
      )}
      {...props}
    />
  );
}

export function CollectionListRowShell({
  className,
  density,
  selected = false,
  ...props
}: ComponentProps<"div"> & {
  density: "compact" | "comfortable";
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/list-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border/60 px-3 outline-none transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40",
        density === "compact" ? "min-h-10 py-1.5" : "min-h-[52px] py-2",
        selected && "bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

export function CollectionCardsShell({
  cardWidth,
  className,
  maxColumns,
  style,
  ...props
}: ComponentProps<"div"> & {
  cardWidth: number;
  maxColumns?: number;
}) {
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
    maxWidth: maxColumns
      ? cardWidth * maxColumns + collectionCardGap * (maxColumns - 1)
      : undefined,
    ...style,
  };

  return (
    <div
      className={cn("grid items-stretch gap-3.5", className)}
      style={gridStyle}
      {...props}
    />
  );
}

export function CollectionCardShell({
  className,
  selected = false,
  ...props
}: ComponentProps<typeof Card> & {
  selected?: boolean;
}) {
  return (
    <Card
      className={cn(
        "group/gallery-card relative h-full gap-0 overflow-hidden rounded-lg bg-card py-0 shadow-none ring-1 ring-foreground/10 outline-none transition-[box-shadow,transform,background]",
        "hover:-translate-y-px hover:shadow-sm hover:ring-foreground/15 focus-visible:ring-2 focus-visible:ring-ring/40",
        selected && "ring-2 ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}

export function CollectionListSkeleton({
  density,
}: {
  density: "compact" | "comfortable";
}) {
  return (
    <CollectionListShell aria-hidden="true">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
        >
          <Skeleton className="size-4" />
          <div className="flex min-w-0 flex-col gap-2">
            <Skeleton className="h-4 w-48 max-w-full" />
            {density === "comfortable" ? (
              <Skeleton className="h-3 w-72 max-w-full" />
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
          </div>
        </div>
      ))}
    </CollectionListShell>
  );
}

export function CollectionCardsSkeleton({
  cardWidth,
  density = "compact",
  hasCover = true,
  maxColumns,
}: {
  cardWidth: number;
  density?: CollectionGalleryCardDensity;
  hasCover?: boolean;
  maxColumns?: number;
}) {
  return (
    <CollectionCardsShell
      cardWidth={cardWidth}
      maxColumns={maxColumns}
      aria-hidden="true"
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <Card
          key={index}
          size={density === "compact" ? "sm" : "default"}
          className="gap-0 overflow-hidden py-0 shadow-none ring-1 ring-foreground/10"
        >
          {hasCover ? (
            <Skeleton className="aspect-video w-full rounded-none" />
          ) : null}
          <CardContent
            className={cn(
              "flex flex-col",
              density === "compact" ? "gap-1.5 px-2.5 py-2.5" : "gap-2 p-3",
            )}
          >
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <div className="flex gap-1.5">
              <Skeleton className="h-5 w-14" />
              <Skeleton className="h-5 w-16" />
            </div>
          </CardContent>
        </Card>
      ))}
    </CollectionCardsShell>
  );
}

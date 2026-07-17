import { Skeleton } from "@/components/ui/skeleton";
import {
  detailPageToolbarClassName,
  detailPageViewClassName,
} from "@/shared/ui/page-layout";

export function CollectionSkeleton() {
  return (
    <div className="flex min-h-full flex-col" aria-hidden="true">
      <div className={detailPageToolbarClassName}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
        <Skeleton className="size-8 shrink-0" />
        <Skeleton className="size-8 shrink-0" />
      </div>
      <div className={detailPageViewClassName}>
        <div className="min-h-[320px] overflow-hidden rounded-md border">
          <div className="grid grid-cols-[minmax(12rem,2fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-4 border-b px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(12rem,2fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-4 border-b px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

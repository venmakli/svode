import { Skeleton } from "@/components/ui/skeleton";

export function CollectionSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-8">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="flex-1" />
    </div>
  );
}

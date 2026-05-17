import type { WheelEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CollectionView } from "@/features/collection/query";
import { viewType } from "../lib/utils";
import { viewIcons } from "./view-icons";

export function SortableViewTab({ view }: { view: CollectionView }) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: view.name });
  const Icon = viewIcons[viewType(view)];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TabsTrigger
          ref={setNodeRef}
          value={view.name}
          data-collection-tab={view.name}
          className={cn(
            collectionTabTriggerClassName,
            isDragging && "opacity-50",
          )}
          style={{ transform: CSS.Transform.toString(transform), transition }}
          {...listeners}
        >
          <Icon />
          <span className="truncate">{view.name}</span>
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent>{view.name}</TooltipContent>
    </Tooltip>
  );
}

export const collectionTabTriggerClassName = "min-w-0 flex-none max-w-[180px]";

export function handleHorizontalWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.currentTarget.scrollLeft += event.deltaY;
}

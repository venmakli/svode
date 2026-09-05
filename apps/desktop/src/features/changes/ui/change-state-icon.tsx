import {
  CircleDotIcon,
  FilesIcon,
  SquareMinusIcon,
  SquarePlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { ChangesFilter } from "../model/list-summary";

const icons = {
  all: FilesIcon,
  modified: CircleDotIcon,
  deleted: SquareMinusIcon,
  untracked: SquarePlusIcon,
  conflict: TriangleAlertIcon,
};
const colors = {
  all: "text-muted-foreground",
  modified: "text-[var(--brand)]",
  deleted: "text-destructive",
  untracked: "text-[var(--property-green)]",
  conflict: "text-warning",
};

export function ChangeStateIcon({
  state,
  className,
}: {
  state: ChangesFilter;
  className?: string;
}) {
  const Icon = icons[state];
  return <Icon className={cn(colors[state], className)} aria-hidden="true" />;
}

import type { LucideIcon } from "lucide-react";
import {
  Calendar,
  CircleFadingArrowUp,
  Columns3,
  LayoutGrid,
  List,
  Table,
} from "lucide-react";
import type {
  CollectionView,
  ViewType,
} from "@/features/collection/query/model";
import { isKnownViewType, viewType } from "../lib/utils";

export const viewIcons: Record<ViewType, LucideIcon> = {
  table: Table,
  board: Columns3,
  calendar: Calendar,
  list: List,
  gallery: LayoutGrid,
};

/** The icon of a view; a type a newer Svode version set has its own. */
export function viewIcon(view: CollectionView): LucideIcon {
  return isKnownViewType(view)
    ? viewIcons[viewType(view)]
    : CircleFadingArrowUp;
}

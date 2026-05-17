import type { LucideIcon } from "lucide-react";
import { Calendar, Columns3, LayoutGrid, List, Table } from "lucide-react";
import type { ViewType } from "@/features/collection/query";

export const viewIcons: Record<ViewType, LucideIcon> = {
  table: Table,
  board: Columns3,
  calendar: Calendar,
  list: List,
  gallery: LayoutGrid,
};

import type { Entry } from "@/features/entry";
import type { CalendarScope } from "./calendar-types";

export type ActiveTab = "document" | string;

export interface CollectionRouteState {
  viewName: string | null;
  onViewNameChange: (viewName: string | null) => void;
  calendarScope: CalendarScope | null;
  onCalendarScopeChange: (scope: CalendarScope) => void;
}

export type SettingsPane =
  | "main"
  | "layout"
  | "properties"
  | "propertyAddType"
  | "propertyEdit"
  | "filter"
  | "filterField"
  | "filterEditor"
  | "sort"
  | "sortField"
  | "sortEditor"
  | "group";

export interface EntryPeekTarget {
  entry: Entry;
  nested: boolean;
  template?: {
    slug: string;
    collectionPath: string;
    isDefault: boolean;
  };
}

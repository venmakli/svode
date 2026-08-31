import type { Page } from "@/features/page";
import type { ScopeSurfaceId } from "@/features/scope-surfaces";
import type { CalendarScope } from "./calendar-types";

export type ActiveTab = string;

export interface CollectionRouteState {
  viewName: string | null;
  onViewNameChange: (viewName: string | null) => void;
  calendarScope: CalendarScope | null;
  onCalendarScopeChange: (scope: CalendarScope) => void;
}

export interface CollectionPeekSurfaceState {
  surfaceId: ScopeSurfaceId;
  onSurfaceIdChange: (surfaceId: ScopeSurfaceId) => void;
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

export interface PagePeekTarget {
  page: Page;
  nested: boolean;
  spaceId?: string | null;
  spacePath?: string | null;
  projectPath?: string | null;
  template?: {
    slug: string;
    collectionPath: string;
    isDefault: boolean;
  };
}

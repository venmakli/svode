import type { ContentActionHandlers } from "@/features/content-actions";
import type { NavigationItem } from "@/features/navigation";
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
  | "propertyType"
  | "filter"
  | "filterField"
  | "filterEditor"
  | "sort"
  | "sortField"
  | "sortEditor"
  | "group";

/** What the context menu of every row of one Collection acts with. */
export interface CollectionEntryMenu {
  readOnly: boolean;
  spacePath: string;
  pinItem: (entry: Page) => NavigationItem | null;
  /** The item's own actions; the row adds how it opens in peek. */
  handlers: (entry: Page) => Omit<ContentActionHandlers, "open-in-peek">;
}

export interface PagePeekTarget {
  page: Page;
  nested: boolean;
  /** The peek opens on its title selected, to rename the item. */
  focusTitle?: boolean;
  spaceId?: string | null;
  spacePath?: string | null;
  projectPath?: string | null;
  template?: {
    slug: string;
    collectionPath: string;
    isDefault: boolean;
  };
}

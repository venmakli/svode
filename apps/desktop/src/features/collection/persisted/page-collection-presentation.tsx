import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "../query/model";
import type { ReactNode } from "react";
import type { Page } from "@/features/page";
import type {
  CollectionSchema,
  RelationOpenTarget,
} from "@/features/properties";
import type { CalendarScope } from "../model/calendar-types";
import type { ViewCreateRequest } from "../hooks";
import type { CollectionPresentationDescriptor } from "../runtime/model/types";
import { BoardView } from "../ui/board/board-view";
import { CalendarView } from "../ui/calendar/calendar-view";
import { GalleryView } from "../ui/gallery/gallery-view";
import { ListView } from "../ui/list/list-view";
import { TableView } from "../ui/table/table-view";

export interface PageCollectionPresentationProps {
  descriptor: CollectionPresentationDescriptor<Page>;
  readOnly: boolean;
  view: CollectionView;
  query: UseViewQueryResult;
  schema: CollectionSchema;
  collectionPath: string;
  previousCollectionPath?: string | null;
  projectPath?: string | null;
  spacePath: string;
  searchQuery: string;
  refreshToken: number;
  calendarScope?: CalendarScope | null;
  createRequest: ViewCreateRequest;
  onClearSearch: () => void;
  onOpenEntry: (entry: Page) => void;
  onOpenNestedPeek: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenFullPage: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
  onDuplicateEntry: (entry: Page) => void;
  onDeleteEntry: (entry: Page) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCalendarScopeChange?: (scope: CalendarScope) => void;
  onCreateEntry: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Page>;
}

export function PageCollectionPresentation({
  descriptor,
  readOnly,
  view,
  query,
  schema,
  collectionPath,
  previousCollectionPath,
  projectPath,
  spacePath,
  searchQuery,
  refreshToken,
  calendarScope,
  createRequest,
  onClearSearch,
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onOpenPath,
  onOpenRelationTarget,
  onDuplicateEntry,
  onDeleteEntry,
  onSchemaChange,
  onUpdateView,
  onCalendarScopeChange,
  onCreateEntry,
}: PageCollectionPresentationProps) {
  const commonProps = {
    readOnly,
    name: view.name,
    view,
    schema,
    properties: descriptor.properties,
    collectionPath,
    previousCollectionPath,
    projectPath,
    spacePath,
    searchQuery,
    filters: query.merged.filter,
    sort: query.merged.sort,
    refreshToken,
    createFocusSignal: createRequest.signal,
    createAsFolder: createRequest.asFolder,
    onClearSearch,
    onOpenEntry,
    onOpenNestedPeek,
    onOpenNestedCollection,
    onOpenFullPage,
    onOpenPath,
    onDuplicateEntry,
    onDeleteEntry,
  };

  const renderers: Record<ViewType, () => ReactNode> = {
    table: () => (
      <TableView
        {...commonProps}
        query={query}
        onOpenRelationTarget={onOpenRelationTarget}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCreateEntry={(title, asFolder) => onCreateEntry(title, asFolder)}
      />
    ),
    board: () => (
      <BoardView
        {...commonProps}
        query={query}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCreateEntry={(title, asFolder, contextualDefaults) =>
          onCreateEntry(title, asFolder, contextualDefaults)
        }
      />
    ),
    calendar: () => (
      <CalendarView
        {...commonProps}
        calendarScope={calendarScope}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCalendarScopeChange={onCalendarScopeChange}
        onCreateEntry={(title, asFolder, contextualDefaults) =>
          onCreateEntry(title, asFolder, contextualDefaults)
        }
      />
    ),
    list: () => (
      <ListView
        {...commonProps}
        query={query}
        onCreateEntry={(title, asFolder) => onCreateEntry(title, asFolder)}
      />
    ),
    gallery: () => (
      <GalleryView
        {...commonProps}
        query={query}
        onCreateEntry={(title, asFolder) => onCreateEntry(title, asFolder)}
      />
    ),
  };
  return renderers[descriptor.layout.kind]();
}

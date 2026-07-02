import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "@/features/collection/query/model";
import type { Entry } from "@/features/entry";
import type { CollectionSchema } from "@/features/properties";
import type { CalendarScope } from "../model/calendar-types";
import type { ViewCreateRequest } from "../hooks";
import { viewType } from "../lib/utils";
import { BoardView } from "./board/board-view";
import { CalendarView } from "./calendar/calendar-view";
import { GalleryView } from "./gallery/gallery-view";
import { ListView } from "./list/list-view";
import { TableView } from "./table/table-view";
import { ViewPlaceholder } from "./view-placeholder";

interface CollectionViewContentProps {
  view: CollectionView;
  query: UseViewQueryResult;
  schema: CollectionSchema;
  collectionPath: string;
  projectPath?: string | null;
  spacePath: string;
  searchQuery: string;
  refreshToken: number;
  calendarScope?: CalendarScope | null;
  createRequest: ViewCreateRequest;
  onClearSearch: () => void;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
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
  ) => Promise<Entry>;
}

export function CollectionViewContent({
  view,
  query,
  schema,
  collectionPath,
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
  onDuplicateEntry,
  onDeleteEntry,
  onSchemaChange,
  onUpdateView,
  onCalendarScopeChange,
  onCreateEntry,
}: CollectionViewContentProps) {
  const type = viewType(view);
  const commonProps = {
    name: view.name,
    view,
    schema,
    collectionPath,
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

  if (type === "table") {
    return (
      <TableView
        {...commonProps}
        query={query}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCreateEntry={(title, asFolder) => onCreateEntry(title, asFolder)}
      />
    );
  }

  if (type === "board") {
    return (
      <BoardView
        {...commonProps}
        query={query}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCreateEntry={(title, asFolder, contextualDefaults) =>
          onCreateEntry(title, asFolder, contextualDefaults)
        }
      />
    );
  }

  if (type === "calendar") {
    return (
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
    );
  }

  if (type === "list") {
    return (
      <ListView
        {...commonProps}
        query={query}
        onCreateEntry={(title, asFolder) => onCreateEntry(title, asFolder)}
      />
    );
  }

  if (type === "gallery") {
    return (
      <GalleryView
        {...commonProps}
        query={query}
        onCreateEntry={(title, asFolder) => onCreateEntry(title, asFolder)}
      />
    );
  }

  return (
    <ViewPlaceholder
      type={type as ViewType}
      name={view.name}
      schema={schema}
      collectionPath={collectionPath}
      projectPath={projectPath}
      spacePath={spacePath}
      searchQuery={searchQuery}
      refreshToken={refreshToken}
      onOpenEntry={onOpenEntry}
      onDuplicateEntry={onDuplicateEntry}
      onDeleteEntry={onDeleteEntry}
    />
  );
}

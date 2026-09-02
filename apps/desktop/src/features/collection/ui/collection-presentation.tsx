import type { ReactNode } from "react";

import type { Page } from "@/features/page";
import type {
  CollectionSchema,
  RelationOpenTarget,
} from "@/features/properties";

import type { ViewCreateRequest } from "../hooks";
import type { CalendarScope } from "../model/calendar-types";
import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "../query/model";
import type {
  CollectionInteractionError,
  CollectionPresentationRuntime,
  CollectionQueryState,
} from "../runtime/model/types";
import {
  activatePageCollectionItem,
  type PageCollectionPresentationDescriptor,
} from "../persisted/page-collection-definition";
import { CollectionPresentationShell } from "../runtime/ui/presentation-shell";
import { BoardView } from "./board/board-view";
import { CalendarView } from "./calendar/calendar-view";
import { GalleryView } from "./gallery/gallery-view";
import { ListView } from "./list/list-view";
import { TableView } from "./table/table-view";

interface FixedCollectionPresentationProps {
  instanceKey: string;
  mode: "fixed";
  onInteractionError?(error: CollectionInteractionError): void;
  onQueryChange(query: CollectionQueryState): void;
  presentation: CollectionPresentationRuntime;
  query: CollectionQueryState;
}

export interface SchemaBackedCollectionPresentationProps {
  descriptor: PageCollectionPresentationDescriptor;
  mode: "schema-backed";
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
  onOpenNestedPeek: (entry: Page) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenFullPage: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
  onDuplicatePage: (page: Page) => void;
  onDeletePage: (page: Page) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCalendarScopeChange?: (scope: CalendarScope) => void;
  onCreatePage: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Page>;
}

export type CollectionPresentationProps =
  | FixedCollectionPresentationProps
  | SchemaBackedCollectionPresentationProps;

export function CollectionPresentation(props: CollectionPresentationProps) {
  if (props.mode === "fixed") {
    return (
      <CollectionPresentationShell
        instanceKey={props.instanceKey}
        presentation={props.presentation}
        query={props.query}
        onInteractionError={props.onInteractionError}
        onQueryChange={props.onQueryChange}
      />
    );
  }
  return <SchemaBackedCollectionPresentation {...props} />;
}

function SchemaBackedCollectionPresentation({
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
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onOpenPath,
  onOpenRelationTarget,
  onDuplicatePage,
  onDeletePage,
  onSchemaChange,
  onUpdateView,
  onCalendarScopeChange,
  onCreatePage,
}: SchemaBackedCollectionPresentationProps) {
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
    onActivateItem: (page: Page) => {
      void activatePageCollectionItem(descriptor, page);
    },
    onOpenNestedPeek,
    onOpenNestedCollection,
    onOpenPath,
    onDuplicatePage,
    onDeletePage,
  };

  const renderers: Record<ViewType, () => ReactNode> = {
    table: () => (
      <TableView
        {...commonProps}
        query={query}
        onOpenRelationTarget={onOpenRelationTarget}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCreatePage={(title, asFolder) => onCreatePage(title, asFolder)}
      />
    ),
    board: () => (
      <BoardView
        {...commonProps}
        query={query}
        onOpenFullPage={onOpenFullPage}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCreatePage={(title, asFolder, contextualDefaults) =>
          onCreatePage(title, asFolder, contextualDefaults)
        }
      />
    ),
    calendar: () => (
      <CalendarView
        {...commonProps}
        calendarScope={calendarScope}
        onOpenFullPage={onOpenFullPage}
        onSchemaChange={onSchemaChange}
        onUpdateView={onUpdateView}
        onCalendarScopeChange={onCalendarScopeChange}
        onCreatePage={(title, asFolder, contextualDefaults) =>
          onCreatePage(title, asFolder, contextualDefaults)
        }
      />
    ),
    list: () => (
      <ListView
        {...commonProps}
        query={query}
        onCreatePage={(title, asFolder) => onCreatePage(title, asFolder)}
      />
    ),
    gallery: () => (
      <GalleryView
        {...commonProps}
        query={query}
        onCreatePage={(title, asFolder) => onCreatePage(title, asFolder)}
      />
    ),
  };
  return renderers[descriptor.layout.kind]();
}

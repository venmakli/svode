import type { EventInput } from "@fullcalendar/core";
import type {
  CollectionView,
  QueryFilter,
  QuerySort,
} from "@/features/collection/query";
import type { Entry } from "@/features/editor/types";
import type {
  CollectionSchema,
  Column,
  Person,
} from "@/features/properties/model";

export type CalendarScope = "month" | "week" | "day" | "list";

export type CalendarDateKind =
  | "date"
  | "datetime"
  | "date-range"
  | "datetime-range";

export interface CalendarDateValue {
  start: string;
  end: string | null;
  allDay: boolean;
  range: boolean;
  kind: CalendarDateKind;
}

export interface CalendarEventModel {
  entry: Entry;
  value: CalendarDateValue;
  dateField: string;
  cardFields: string[];
  customColumns: Column[];
  folder: boolean;
  nestedCollection: boolean;
  color: string | null;
}

export interface CalendarEventInput extends EventInput {
  extendedProps: {
    model: CalendarEventModel;
  };
}

export interface CalendarViewProps {
  name: string;
  view: CollectionView;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  searchQuery: string;
  filters: QueryFilter[];
  sort: QuerySort[];
  refreshToken: number;
  createFocusSignal?: number;
  createAsFolder?: boolean;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onOpenFullPage: (entry: Entry) => void;
  onDuplicateEntry: (entry: Entry) => void;
  onDeleteEntry: (entry: Entry) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onCreateEntry: (
    title: string,
    asFolder: boolean,
    contextualDefaults?: Record<string, unknown>,
  ) => Promise<Entry>;
}

export interface CalendarPropertyContext {
  persons: Person[];
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onUpdateField: (entry: Entry, column: Column, value: unknown) => void;
}

export interface CalendarCreateDraft {
  anchor: { x: number; y: number };
  dateValue: unknown;
  asFolder: boolean;
}

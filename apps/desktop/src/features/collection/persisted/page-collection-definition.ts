import type { Page } from "@/features/page";
import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  defineSchemaBackedCollectionProperty,
  type CollectionPropertyDefinition,
  type CollectionSchema,
} from "@/features/properties";

import { normalizeBoardCardFields } from "../lib/board-view";
import { normalizeGalleryCardFields } from "../lib/gallery-view";
import { normalizeListCardFields } from "../lib/list-view";
import { normalizeVisibleFields } from "../lib/table-view";
import { viewType } from "../lib/utils";
import {
  calendarDateColumn,
  normalizeCalendarCardFields,
} from "../model/calendar-utils";
import type { CollectionView, ViewType } from "../query/model";
import type {
  CollectionActivationContext,
  CollectionInstance,
  CollectionPresentationDescriptor,
  CollectionPresentationLayout,
} from "../runtime/model/types";
import {
  runCollectionCallback,
  type CollectionCallbackResult,
} from "../runtime/lib/interaction";
import * as m from "@/paraglide/messages.js";

const STRUCTURED_FIELDS = new Set(["title", "icon", "description", "cover"]);

export interface PageCollectionPresentationDescriptor extends CollectionPresentationDescriptor<Page> {
  onActivate(
    page: Page,
    context: CollectionActivationContext,
  ): void | Promise<void>;
}

export interface PageCollectionDefinition extends CollectionInstance<PageCollectionPresentationDescriptor> {
  properties: readonly CollectionPropertyDefinition<Page>[];
}

export function definePageCollection({
  collectionPath,
  onActivate,
  schema,
  views,
}: {
  collectionPath: string;
  onActivate(
    page: Page,
    context: CollectionActivationContext,
  ): void | Promise<void>;
  schema: CollectionSchema;
  views: readonly CollectionView[];
}): PageCollectionDefinition {
  const properties = definePageCollectionProperties(schema);
  return {
    defaultPresentationId: views[0]?.name ?? "",
    instanceKey: `page:${collectionPath}`,
    presentations: views.map((view) =>
      definePageCollectionPresentation({
        onActivate,
        properties,
        schema,
        view,
      }),
    ),
    properties,
    stateScope: "lifecycle",
  };
}

export function definePageCollectionProperties(
  schema: CollectionSchema,
): readonly CollectionPropertyDefinition<Page>[] {
  return [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "collection",
      getValue: (page) => page.meta.title,
      key: "title",
      label: schema.systemFields?.title?.label ?? m.collection_field_title(),
      standard: { type: "text" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "collection",
      getValue: (page) => page.meta.created,
      key: "created",
      label: m.collection_field_created(),
      standard: { display: "medium", type: "date" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "collection",
      getValue: (page) => page.meta.updated,
      key: "updated",
      label: m.collection_field_updated(),
      standard: { display: "medium", type: "date" },
    }),
    ...schema.columns.map((column) =>
      defineSchemaBackedCollectionProperty({
        capabilities: {
          filter: { kind: "standard" },
          sort: { kind: "standard" },
        },
        column,
        getAccessibilityLabel: (page: Page) =>
          `${column.name}: ${page.meta.title}`,
        getValue: (page: Page) => page.meta.extra[column.name],
      }),
    ),
  ];
}

export function activatePageCollectionItem(
  descriptor: PageCollectionPresentationDescriptor,
  page: Page,
): Promise<CollectionCallbackResult> {
  return runCollectionCallback(
    () => descriptor.onActivate(page, { rowId: descriptor.getRowId(page) }),
    m.collection_callback_error(),
  );
}

function definePageCollectionPresentation({
  onActivate,
  properties,
  schema,
  view,
}: {
  onActivate(
    page: Page,
    context: CollectionActivationContext,
  ): void | Promise<void>;
  properties: readonly CollectionPropertyDefinition<Page>[];
  schema: CollectionSchema;
  view: CollectionView;
}): PageCollectionPresentationDescriptor {
  const type = viewType(view);
  return {
    getRowId: (page) => page.path,
    id: view.name,
    label: view.name,
    layout: pagePresentationLayouts[type]({ schema, view }),
    onActivate,
    properties,
    query: {},
  };
}

const pagePresentationLayouts: Record<
  ViewType,
  (input: {
    schema: CollectionSchema;
    view: CollectionView;
  }) => CollectionPresentationLayout<Page>
> = {
  table: ({ schema, view }) => ({
    density: view.density === "compact" ? "compact" : "comfortable",
    kind: "table",
    primaryProperty: "title",
    visibleProperties: normalizeVisibleFields(view, schema).filter(
      (field) => field !== "icon",
    ),
  }),
  board: ({ schema, view }) => ({
    getTitle: (page) => page.meta.title,
    groupByProperty:
      typeof (view.group_by ?? view.groupBy) === "string"
        ? String(view.group_by ?? view.groupBy)
        : null,
    kind: "board",
    visibleProperties: propertyFields(normalizeBoardCardFields(view, schema)),
  }),
  calendar: ({ schema, view }) => ({
    dateProperty: calendarDateColumn(view, schema)?.name ?? null,
    getTitle: (page) => page.meta.title,
    kind: "calendar",
    visibleProperties: propertyFields(
      normalizeCalendarCardFields(view, schema),
    ),
  }),
  list: ({ schema, view }) => ({
    density: view.density === "compact" ? "compact" : "comfortable",
    getDescription: (page) => page.meta.description,
    getTitle: (page) => page.meta.title,
    kind: "list",
    visibleProperties: propertyFields(normalizeListCardFields(view, schema)),
  }),
  gallery: ({ schema, view }) => ({
    cardSize: normalizedGallerySize(view.size),
    density: view.density === "comfortable" ? "comfortable" : "compact",
    getDescription: (page) => page.meta.description,
    getTitle: (page) => page.meta.title,
    kind: "gallery",
    visibleProperties: propertyFields(normalizeGalleryCardFields(view, schema)),
  }),
};

function propertyFields(fields: readonly string[]): string[] {
  return fields.filter((field) => !STRUCTURED_FIELDS.has(field));
}

function normalizedGallerySize(value: unknown): "small" | "medium" | "large" {
  return value === "small" || value === "large" ? value : "medium";
}

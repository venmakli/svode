import {
  useMemo,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  ColumnDef,
  ColumnSizingState,
  HeaderContext,
  RowData,
} from "@tanstack/react-table";
import type { Page } from "@/features/page";
import type {
  CollectionView,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type {
  CollectionSchema,
  CollectionPropertyDefinition,
  Column,
  ActorCandidate,
  RelationOpenTarget,
} from "@/features/properties";
import {
  normalizeSchema,
  resolveStandardPropertyColumn,
} from "@/features/properties";
import { PROPERTY_TYPE_ICONS } from "@/features/properties";
import { ColumnMenuPopover } from "./column-menu";
import { PropertyCell, TitleCell } from "./cells";
import { TITLE_ICON } from "./icons";
import { ColumnHeader } from "./table-shell";
import type { CollectionTableRow, TableEditingCell } from "./types";
import {
  defaultColumnWidth,
  isExpandable,
  isNestedCollection,
  minColumnWidth,
} from "./utils";
import * as m from "@/paraglide/messages.js";

interface TableColumnHeaderMeta extends Omit<
  ComponentProps<typeof ColumnHeader>,
  "children" | "onResizeMouseDown"
> {
  menu: Omit<ComponentProps<typeof ColumnMenuPopover>, "trigger"> | null;
}

declare module "@tanstack/react-table" {
  // Type parameters must match the declaration being merged.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    header?: TableColumnHeaderMeta;
  }
}

// One component type for every header: an inline `header` function would be a
// new component on each column recompute and remount the open column menu.
function TableColumnHeader({
  header,
}: HeaderContext<CollectionTableRow, unknown>) {
  const meta = header.column.columnDef.meta?.header;
  if (!meta) return null;
  const { menu, ...headerProps } = meta;
  return (
    <ColumnHeader
      {...headerProps}
      onResizeMouseDown={header.getResizeHandler()}
    >
      {menu ? <ColumnMenuPopover {...menu} trigger={<span />} /> : null}
    </ColumnHeader>
  );
}

export function useTableColumns({
  readOnly,
  visibleFields,
  schema,
  properties,
  view,
  query,
  collectionPath,
  spacePath,
  projectPath,
  columnSizing,
  editing,
  openColumn,
  entries,
  expanded,
  nestedCollectionPaths,
  showNested,
  actors,
  setEditing,
  setOpenColumn,
  setExpanded,
  onSchemaChange,
  onUpdateViewPatch,
  onOpenNestedCollection,
  onOpenPath,
  onOpenRelationTarget,
  onRequestActors,
  onCommitField,
}: {
  readOnly: boolean;
  visibleFields: string[];
  schema: CollectionSchema;
  properties: readonly CollectionPropertyDefinition<Page>[];
  view: CollectionView;
  query: UseViewQueryResult;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  columnSizing: ColumnSizingState;
  editing: TableEditingCell | null;
  openColumn: string | null;
  entries: Page[];
  expanded: Set<string>;
  nestedCollectionPaths: Set<string>;
  showNested: boolean;
  actors: ActorCandidate[];
  setEditing: Dispatch<SetStateAction<TableEditingCell | null>>;
  setOpenColumn: (field: string | null) => void;
  setExpanded: (path: string) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateViewPatch: (patch: Record<string, unknown>) => Promise<void>;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onCommitField: (
    entry: Page,
    column: Column,
    value: unknown,
    options?: { flush?: boolean },
  ) => void;
}) {
  return useMemo<ColumnDef<CollectionTableRow>[]>(() => {
    const showTitleIcon = visibleFields.includes("icon");

    return visibleFields
      .filter((field) => field !== "icon")
      .map((field) => {
        if (field === "title") {
          const label =
            properties.find((property) => property.key === "title")?.label ??
            m.collection_field_title();
          return {
            id: "title",
            size: columnSizing.title ?? 260,
            minSize: 200,
            header: TableColumnHeader,
            meta: {
              header: {
                readOnly,
                label,
                icon: TITLE_ICON,
                open: openColumn === "title",
                onOpenChange: (open) => setOpenColumn(open ? "title" : null),
                menu: {
                  field: "title",
                  label,
                  open: openColumn === "title",
                  view,
                  query,
                  schema,
                  collectionPath,
                  spacePath,
                  projectPath,
                  onOpenChange: (open) => setOpenColumn(open ? "title" : null),
                  onSchemaChange: (next) =>
                    onSchemaChange(normalizeSchema(next)),
                  onUpdateViewPatch,
                },
              },
            },
            cell: ({ row }) => (
              <TitleCell
                row={row.original}
                showIcon={showTitleIcon}
                expandable={isExpandable(
                  row.original.entry,
                  entries,
                  showNested,
                  nestedCollectionPaths,
                )}
                expanded={expanded.has(row.original.entry.path)}
                nested={isNestedCollection(
                  row.original.entry,
                  nestedCollectionPaths,
                )}
                onToggle={() => setExpanded(row.original.entry.path)}
                onOpenNested={() => onOpenNestedCollection(row.original.entry)}
              />
            ),
          };
        }

        const propertyDefinition = properties.find(
          (candidate) => candidate.key === field,
        );
        const property = propertyDefinition
          ? resolveStandardPropertyColumn(propertyDefinition)
          : null;
        const Icon = PROPERTY_TYPE_ICONS[property?.type ?? "text"];
        return {
          id: field,
          size:
            columnSizing[field] ?? defaultColumnWidth(property ?? undefined),
          minSize: minColumnWidth(property ?? undefined),
          header: TableColumnHeader,
          meta: {
            header: {
              readOnly,
              label: propertyDefinition?.label ?? field,
              icon: Icon,
              open: openColumn === field,
              onOpenChange: (open) => setOpenColumn(open ? field : null),
              menu: property
                ? {
                    field,
                    label: field,
                    column: property,
                    open: openColumn === field,
                    view,
                    query,
                    schema,
                    collectionPath,
                    spacePath,
                    projectPath,
                    affectedEntries: entries.filter(
                      (entry) => entry.meta.extra?.[field] !== undefined,
                    ).length,
                    actors,
                    onRequestActors: (allTime = false) =>
                      onRequestActors(allTime),
                    onOpenChange: (open) => setOpenColumn(open ? field : null),
                    onSchemaChange: (next) =>
                      onSchemaChange(normalizeSchema(next)),
                    onUpdateViewPatch,
                  }
                : null,
            },
          },
          cell: ({ row }) =>
            property && propertyDefinition ? (
              <PropertyCell
                readOnly={readOnly}
                column={property}
                pageLabel={row.original.entry.meta.title}
                actors={actors}
                onRequestActors={onRequestActors}
                relationContext={{
                  spacePath,
                  projectPath,
                  currentFilePath: row.original.entry.path,
                  onOpenPath,
                  onOpenRelationTarget,
                }}
                value={propertyDefinition.getValue(row.original.entry)}
                editing={
                  editing?.path === row.original.entry.path &&
                  editing.field === property.name
                }
                onEdit={() =>
                  setEditing({
                    path: row.original.entry.path,
                    field: property.name,
                  })
                }
                onCancel={() => setEditing(null)}
                onCommit={(value, options) => {
                  if (options?.close !== false) setEditing(null);
                  onCommitField(row.original.entry, property, value, {
                    flush: options?.close === true,
                  });
                }}
              />
            ) : (
              <span className="text-muted-foreground">-</span>
            ),
        };
      });
  }, [
    collectionPath,
    columnSizing,
    editing,
    entries,
    expanded,
    nestedCollectionPaths,
    onCommitField,
    onOpenRelationTarget,
    onOpenNestedCollection,
    onOpenPath,
    onRequestActors,
    onSchemaChange,
    onUpdateViewPatch,
    openColumn,
    actors,
    projectPath,
    properties,
    query,
    readOnly,
    schema,
    setEditing,
    setExpanded,
    setOpenColumn,
    showNested,
    spacePath,
    view,
    visibleFields,
  ]);
}

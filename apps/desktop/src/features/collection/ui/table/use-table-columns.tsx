import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { ColumnDef, ColumnSizingState } from "@tanstack/react-table";
import type { Entry } from "@/features/entry";
import type {
  CollectionView,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type {
  CollectionSchema,
  Column,
  ActorCandidate,
  RelationOpenTarget,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { ColumnMenuPopover } from "./column-menu";
import { PropertyCell, TitleCell } from "./cells";
import { PROPERTY_TYPE_ICONS, TITLE_ICON } from "./icons";
import { ColumnHeader } from "./table-shell";
import type { CollectionTableRow, TableEditingCell } from "./types";
import {
  defaultColumnWidth,
  isExpandable,
  isNestedCollection,
  minColumnWidth,
} from "./utils";
import * as m from "@/paraglide/messages.js";

export function useTableColumns({
  visibleFields,
  schema,
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
  onOpenEntry,
  onOpenNestedPeek,
  onOpenNestedCollection,
  onOpenFullPage,
  onOpenPath,
  onOpenRelationTarget,
  onRequestActors,
  onCommitField,
}: {
  visibleFields: string[];
  schema: CollectionSchema;
  view: CollectionView;
  query: UseViewQueryResult;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  columnSizing: ColumnSizingState;
  editing: TableEditingCell | null;
  openColumn: string | null;
  entries: Entry[];
  expanded: Set<string>;
  nestedCollectionPaths: Set<string>;
  showNested: boolean;
  actors: ActorCandidate[];
  setEditing: Dispatch<SetStateAction<TableEditingCell | null>>;
  setOpenColumn: (field: string | null) => void;
  setExpanded: (path: string) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateViewPatch: (patch: Record<string, unknown>) => Promise<void>;
  onOpenEntry: (entry: Entry) => void;
  onOpenNestedPeek: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onOpenRelationTarget: (target: RelationOpenTarget) => void;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onCommitField: (
    entry: Entry,
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
            schema.systemFields?.title?.label || m.collection_field_title();
          return {
            id: "title",
            size: columnSizing.title ?? 260,
            minSize: 200,
            header: ({ header }) => (
              <ColumnHeader
                field="title"
                label={label}
                icon={TITLE_ICON}
                open={openColumn === "title"}
                onOpenChange={(open) => setOpenColumn(open ? "title" : null)}
                onResizeMouseDown={header.getResizeHandler()}
              >
                <ColumnMenuPopover
                  field="title"
                  label={label}
                  open={openColumn === "title"}
                  view={view}
                  query={query}
                  schema={schema}
                  collectionPath={collectionPath}
                  spacePath={spacePath}
                  projectPath={projectPath}
                  onOpenChange={(open) => setOpenColumn(open ? "title" : null)}
                  onSchemaChange={(next) =>
                    onSchemaChange(normalizeSchema(next))
                  }
                  onUpdateViewPatch={onUpdateViewPatch}
                  trigger={<span />}
                />
              </ColumnHeader>
            ),
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
                onOpen={() =>
                  isNestedCollection(row.original.entry, nestedCollectionPaths)
                    ? onOpenNestedPeek(row.original.entry)
                    : onOpenEntry(row.original.entry)
                }
                onOpenFullPage={() => onOpenFullPage(row.original.entry)}
                onOpenNested={() => onOpenNestedCollection(row.original.entry)}
              />
            ),
          };
        }

        const property = schema.columns.find((column) => column.name === field);
        const Icon = PROPERTY_TYPE_ICONS[property?.type ?? "text"];
        return {
          id: field,
          size: columnSizing[field] ?? defaultColumnWidth(property),
          minSize: minColumnWidth(property),
          header: ({ header }) => (
            <ColumnHeader
              field={field}
              label={field}
              icon={Icon}
              open={openColumn === field}
              onOpenChange={(open) => setOpenColumn(open ? field : null)}
              onResizeMouseDown={header.getResizeHandler()}
            >
              {property ? (
                <ColumnMenuPopover
                  field={field}
                  label={field}
                  column={property}
                  open={openColumn === field}
                  view={view}
                  query={query}
                  schema={schema}
                  collectionPath={collectionPath}
                  spacePath={spacePath}
                  projectPath={projectPath}
                  affectedEntries={
                    entries.filter(
                      (entry) => entry.meta.extra?.[field] !== undefined,
                    ).length
                  }
                  actors={actors}
                  onRequestActors={(allTime = false) =>
                    onRequestActors(allTime)
                  }
                  onOpenChange={(open) => setOpenColumn(open ? field : null)}
                  onSchemaChange={(next) =>
                    onSchemaChange(normalizeSchema(next))
                  }
                  onUpdateViewPatch={onUpdateViewPatch}
                  trigger={<span />}
                />
              ) : null}
            </ColumnHeader>
          ),
          cell: ({ row }) =>
            property ? (
              <PropertyCell
                column={property}
                actors={actors}
                onRequestActors={onRequestActors}
                relationContext={{
                  spacePath,
                  projectPath,
                  currentFilePath: row.original.entry.path,
                  onOpenPath,
                  onOpenRelationTarget,
                }}
                value={row.original.entry.meta.extra?.[property.name] ?? null}
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
    onOpenEntry,
    onOpenFullPage,
    onOpenRelationTarget,
    onOpenNestedPeek,
    onOpenNestedCollection,
    onOpenPath,
    onRequestActors,
    onSchemaChange,
    onUpdateViewPatch,
    openColumn,
    actors,
    projectPath,
    query,
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

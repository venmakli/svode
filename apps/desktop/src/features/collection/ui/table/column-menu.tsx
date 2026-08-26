import { useState, type ReactNode } from "react";
import { MultiPanePopover } from "@/shared/ui/multi-pane-popover";
import type {
  CollectionView,
  UseViewQueryResult,
} from "@/features/collection/query/model";
import type {
  ActorCandidate,
  CollectionSchema,
  Column,
} from "@/features/properties";
import { SchemaColumnMenu } from "@/features/properties/column-menu";
import { useCollectionColumnActions } from "../../hooks";
import { FieldFilterPane, FieldSortPane } from "./column-query-pane";
import {
  TableSchemaMenuExtension,
  TitleColumnMainPane,
} from "./column-menu-panes";
import { normalizeVisibleFields } from "./utils";
import * as m from "@/paraglide/messages.js";

export function ColumnMenuPopover({
  trigger,
  field,
  label,
  column,
  open,
  view,
  query,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  actors = [],
  onRequestActors,
  affectedEntries = 0,
  onOpenChange,
  onSchemaChange,
  onUpdateViewPatch,
}: {
  trigger: ReactNode;
  field: string;
  label: string;
  column?: Column;
  open: boolean;
  view: CollectionView;
  query: UseViewQueryResult;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  actors?: ActorCandidate[];
  onRequestActors?: (allTime?: boolean) => Promise<ActorCandidate[]>;
  affectedEntries?: number;
  onOpenChange: (open: boolean) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onUpdateViewPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const visibleFields = normalizeVisibleFields(view, schema);
  const filter =
    query.merged.filter.find((item) => item.field === field) ?? null;
  const sort = query.merged.sort.find((item) => item.field === field) ?? null;
  const extensionPanes = [
    {
      id: "filter",
      title: m.view_query_filter_editor_title({ field }),
      content: (
        <FieldFilterPane
          field={field}
          schema={schema}
          query={query}
          actors={actors}
          onRequestActors={onRequestActors}
          onSaved={onSchemaChange}
        />
      ),
      notice: m.view_query_local_notice(),
    },
    {
      id: "sort",
      title: m.view_query_sort_editor_title({ field }),
      content: (
        <FieldSortPane field={field} query={query} onSaved={onSchemaChange} />
      ),
    },
  ];

  if (column) {
    return (
      <SchemaColumnMenu
        trigger={trigger}
        open={open}
        column={column}
        schema={schema}
        collectionPath={collectionPath}
        spacePath={spacePath}
        projectPath={projectPath}
        affectedEntries={affectedEntries}
        extensionPanes={extensionPanes}
        renderMainExtension={(controls) => (
          <TableSchemaMenuExtension
            field={field}
            visibleFields={visibleFields}
            filter={filter}
            sort={sort}
            onUpdateViewPatch={onUpdateViewPatch}
            controls={controls}
          />
        )}
        onOpenChange={onOpenChange}
        onSchemaChange={onSchemaChange}
        onRenameCommitted={async (oldName, newName) => {
          await onUpdateViewPatch({
            visible_fields: visibleFields.map((visible) =>
              visible === oldName ? newName : visible,
            ),
          });
        }}
      />
    );
  }

  return (
    <TitleColumnMenu
      trigger={trigger}
      open={open}
      label={label}
      field={field}
      filter={filter}
      sort={sort}
      extensionPanes={extensionPanes}
      schema={schema}
      collectionPath={collectionPath}
      spacePath={spacePath}
      projectPath={projectPath}
      onOpenChange={onOpenChange}
      onSchemaChange={onSchemaChange}
    />
  );
}

function TitleColumnMenu({
  trigger,
  open,
  label,
  field,
  filter,
  sort,
  extensionPanes,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  onOpenChange,
  onSchemaChange,
}: {
  trigger: ReactNode;
  open: boolean;
  label: string;
  field: string;
  filter: UseViewQueryResult["merged"]["filter"][number] | null;
  sort: UseViewQueryResult["merged"]["sort"][number] | null;
  extensionPanes: Array<{
    id: string;
    title: string;
    content: ReactNode;
    notice?: string;
  }>;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  onOpenChange: (open: boolean) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  const [pane, setPane] = useState("main");
  const [draftLabel, setDraftLabel] = useState(label);
  const { updateSystemFieldLabel } = useCollectionColumnActions({
    schema,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });
  const panes = [
    {
      id: "main",
      title: label,
      content: (
        <TitleColumnMainPane
          label={draftLabel}
          filter={filter}
          sort={sort}
          onLabelChange={setDraftLabel}
          onOpenPane={setPane}
          onRename={(nextLabel) =>
            void updateSystemFieldLabel({ field, label: nextLabel })
          }
        />
      ),
    },
    ...extensionPanes,
  ];

  return (
    <MultiPanePopover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setPane("main");
          setDraftLabel(label);
        }
        onOpenChange(nextOpen);
      }}
      pane={pane}
      onPaneChange={setPane}
      mainPane="main"
      panes={panes}
      trigger={trigger}
      className="w-[260px]"
    />
  );
}

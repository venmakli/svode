import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { MultiPanePopover } from "@/features/collection/query";
import type {
  CollectionView,
  UseViewQueryResult,
} from "@/features/collection/query";
import type { CollectionSchema, Column } from "@/features/properties";
import type { ActorCandidate } from "@/features/properties";
import { TypeSettingsPane } from "@/features/properties/column-settings";
import { useCollectionColumnActions } from "../../hooks";
import { FieldFilterPane, FieldSortPane } from "./column-query-pane";
import {
  ColumnDangerActions,
  MainPane,
  TypePane,
  type ColumnMenuPane,
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
  const [pane, setPane] = useState<ColumnMenuPane>("main");
  const [draftLabel, setDraftLabel] = useState(label);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteValues, setDeleteValues] = useState(false);
  const visibleFields = normalizeVisibleFields(view, schema);
  const isTitle = field === "title";
  const filter =
    query.merged.filter.find((item) => item.field === field) ?? null;
  const sort = query.merged.sort.find((item) => item.field === field) ?? null;
  const {
    changeColumnType,
    deleteColumn,
    duplicateColumn,
    renameColumn,
    updateSystemFieldLabel,
  } = useCollectionColumnActions({
    schema,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });

  const panes = [
    {
      id: "main" as const,
      title: label,
      content: (
        <MainPane
          field={field}
          label={draftLabel}
          column={column}
          isTitle={isTitle}
          visibleFields={visibleFields}
          filter={filter}
          sort={sort}
          onLabelChange={setDraftLabel}
          onUpdateViewPatch={onUpdateViewPatch}
          onOpenPane={setPane}
          onClose={() => onOpenChange(false)}
          onRenameSystemField={(label) =>
            void updateSystemFieldLabel({ field: "title", label })
          }
          onRenameColumn={(newName, nextVisibleFields, updateViewPatch) =>
            void renameColumn({
              oldName: field,
              newName,
              visibleFields: nextVisibleFields,
              onUpdateViewPatch: updateViewPatch,
            })
          }
        />
      ),
      footer: column ? (
        <ColumnDangerActions
          column={column}
          onDuplicateColumn={(columnToDuplicate, baseName) =>
            void duplicateColumn(columnToDuplicate, baseName)
          }
          onDelete={() => setDeleteOpen(true)}
        />
      ) : null,
    },
    {
      id: "type" as const,
      title: m.table_column_type(),
      content: column ? (
        <TypePane
          activeType={column.type}
          onSelect={(type) => {
            void changeColumnType({ columnName: field, newType: type });
          }}
        />
      ) : null,
      notice: m.table_property_type_notice(),
    },
    {
      id: "filter" as const,
      title: m.view_query_filter_editor_title({ field }),
      content: (
        <FieldFilterPane
          field={field}
          schema={schema}
          query={query}
          actors={actors}
          onRequestActors={onRequestActors}
          onSaved={(next) => onSchemaChange(next)}
        />
      ),
      notice: m.view_query_local_notice(),
    },
    {
      id: "sort" as const,
      title: m.view_query_sort_editor_title({ field }),
      content: (
        <FieldSortPane
          field={field}
          query={query}
          onSaved={(next) => onSchemaChange(next)}
        />
      ),
    },
    {
      id: "settings" as const,
      title: m.table_type_settings(),
      content: column ? (
        <TypeSettingsPane
          column={column}
          spacePath={spacePath}
          collectionPath={collectionPath}
          projectPath={projectPath}
          onSchemaChange={onSchemaChange}
        />
      ) : null,
    },
  ];

  return (
    <>
      <MultiPanePopover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setPane("main");
          onOpenChange(nextOpen);
        }}
        pane={pane}
        onPaneChange={setPane}
        mainPane="main"
        panes={panes}
        trigger={trigger}
        className="w-[260px]"
      />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.property_dialog_delete_column_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.property_dialog_delete_column_desc({ name: field })}{" "}
              {m.table_delete_column_affected({ count: affectedEntries })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={deleteValues}
              onCheckedChange={(checked) => setDeleteValues(checked === true)}
            />
            {m.property_dialog_delete_values()}
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.settings_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void deleteColumn({ columnName: field, deleteValues });
                onOpenChange(false);
              }}
            >
              {m.table_delete_column()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

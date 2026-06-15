import { useState, type ReactNode } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { toast } from "sonner";
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
import type {
  ChangeSchemaTypeResult,
  CollectionSchema,
  Column,
  SchemaMutationWarning,
} from "@/features/properties/model";
import type { Person } from "@/features/properties/model";
import { FieldFilterPane, FieldSortPane } from "./column-query-pane";
import {
  ColumnDangerActions,
  MainPane,
  TypePane,
  type ColumnMenuPane,
} from "./column-menu-panes";
import { TypeSettingsPane } from "./column-type-settings";
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
  persons = [],
  onRequestPersons,
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
  persons?: Person[];
  onRequestPersons?: (allTime?: boolean) => Promise<Person[]>;
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

  const patchColumn = async (patch: Record<string, unknown>) => {
    if (!column) return;
    try {
      const next = await invoke<CollectionSchema>("update_schema_column", {
        space: spacePath,
        collectionPath,
        columnName: column.name,
        patch,
        projectPath: projectPath ?? null,
      });
      onSchemaChange(next);
    } catch (error) {
      console.error(error);
      toast.error(errorMessage(error));
    }
  };

  const panes = [
    {
      id: "main" as const,
      title: label,
      content: (
        <MainPane
          field={field}
          label={draftLabel}
          column={column}
          collectionPath={collectionPath}
          spacePath={spacePath}
          projectPath={projectPath}
          isTitle={isTitle}
          visibleFields={visibleFields}
          filter={filter}
          sort={sort}
          onLabelChange={setDraftLabel}
          onSchemaChange={onSchemaChange}
          onUpdateViewPatch={onUpdateViewPatch}
          onOpenPane={setPane}
          onClose={() => onOpenChange(false)}
        />
      ),
      footer: column ? (
        <ColumnDangerActions
          column={column}
          schema={schema}
          collectionPath={collectionPath}
          spacePath={spacePath}
          projectPath={projectPath}
          onSchemaChange={onSchemaChange}
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
            void invoke<ChangeSchemaTypeResult>("change_schema_type", {
              space: spacePath,
              collectionPath,
              columnName: field,
              newType: type,
              conversionStrategy:
                type === "relation"
                  ? { relation: collectionPath || "." }
                  : null,
              projectPath: projectPath ?? null,
            })
              .then((result) => {
                onSchemaChange(result.schema);
                showSchemaMutationWarnings(result.warnings);
              })
              .catch((error) => {
                console.error(error);
                toast.error(errorMessage(error));
              });
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
          persons={persons}
          onRequestPersons={onRequestPersons}
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
          onPatchColumn={(patch) => void patchColumn(patch)}
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
                void invoke<CollectionSchema>("delete_schema_column", {
                  space: spacePath,
                  collectionPath,
                  columnName: field,
                  deleteValues,
                  projectPath: projectPath ?? null,
                }).then(onSchemaChange);
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

function showSchemaMutationWarnings(warnings: SchemaMutationWarning[]) {
  for (const warning of warnings) {
    if (warning.code === "relation_unconverted_values") {
      toast.warning(
        m.property_relation_convert_warning({
          count: String(warning.count),
          field: warning.field,
        }),
      );
    }
  }
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return m.toast_error();
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AlertTriangle, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import type {
  CollectionSchema,
  Column,
  EntrySchemaResult,
  Person,
  PropertyOption,
} from "./types";
import {
  PropertyControl,
  shouldClosePropertyEditorOnChange,
  validatePropertyValue,
} from "./property-control";
import { PropertyValue } from "./property-value";
import {
  AddColumnDialog,
  AddOptionDialog,
  ChangeTypeDialog,
  DeleteColumnDialog,
  DeleteOptionDialog,
  RenameColumnDialog,
  RenameOptionDialog,
} from "./schema-dialogs";
import { normalizeSchema, valueToString } from "./utils";
import * as m from "@/paraglide/messages.js";

interface PropertyPanelProps {
  spacePath: string;
  projectPath?: string | null;
  filePath: string;
  metaId: string;
  schemaResult: EntrySchemaResult;
  values: Record<string, unknown>;
  mode?: "peek" | "full";
  onValueChange: (field: string, value: unknown) => Promise<void>;
  onSchemaChange?: (result: EntrySchemaResult | null) => void;
}

type DialogState =
  | { type: "add-column" }
  | { type: "change-type"; column: Column }
  | { type: "rename-column"; column: Column }
  | { type: "delete-column"; column: Column }
  | { type: "add-option"; column: Column }
  | { type: "rename-option"; column: Column; option: PropertyOption }
  | { type: "delete-option"; column: Column; option: PropertyOption }
  | null;

export function PropertyPanel({
  spacePath,
  projectPath,
  filePath,
  metaId,
  schemaResult,
  values,
  mode = "peek",
  onValueChange,
  onSchemaChange,
}: PropertyPanelProps) {
  const [schema, setSchema] = useState(() => normalizeSchema(schemaResult.schema));
  const [collectionRootPath, setCollectionRootPath] = useState(
    schemaResult.collectionRootPath ?? schemaResult.collection_root_path ?? "",
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const [persons, setPersons] = useState<Person[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);

  useEffect(() => {
    setSchema(normalizeSchema(schemaResult.schema));
    setCollectionRootPath(
      schemaResult.collectionRootPath ?? schemaResult.collection_root_path ?? "",
    );
    setEditingField(null);
  }, [schemaResult]);

  const hasPerson = useMemo(
    () => schema.columns.some((column) => column.type === "person"),
    [schema.columns],
  );

  const loadPersons = useCallback(
    async (allTime = false) => {
      if (!spacePath) return [];
      const list = await invoke<Person[]>("list_persons", {
        spacePath,
        allTime,
      });
      setPersons(list);
      return list;
    },
    [spacePath],
  );

  useEffect(() => {
    if (hasPerson) {
      void loadPersons().catch((error) => {
        console.warn("Failed to load persons:", error);
      });
    }
  }, [hasPerson, loadPersons]);

  const refreshSchema = useCallback(async () => {
    const result = await invoke<EntrySchemaResult | null>("get_entry_schema", {
      space: spacePath,
      filePath,
    });
    if (result) {
      setSchema(normalizeSchema(result.schema));
      setCollectionRootPath(result.collectionRootPath ?? result.collection_root_path ?? "");
    }
    onSchemaChange?.(result);
    return result;
  }, [filePath, onSchemaChange, spacePath]);

  const schemaInvoke = useCallback(
    async (command: string, args: Record<string, unknown>) => {
      await invoke(command, {
        space: spacePath,
        collectionPath: collectionRootPath,
        projectPath: projectPath ?? null,
        ...args,
      });
      await refreshSchema();
    },
    [collectionRootPath, projectPath, refreshSchema, spacePath],
  );

  const columnNames = new Set(schema.columns.map((column) => column.name));
  const orphanEntries = Object.entries(values).filter(([key]) => !columnNames.has(key));

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "grid gap-x-6 gap-y-2",
          mode === "full"
            ? "grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_auto] md:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_auto_minmax(7rem,12rem)_minmax(0,1fr)_auto]"
            : "grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_auto]",
        )}
      >
        {schema.columns.map((column) => {
          const state = validatePropertyValue(column, values[column.name]);
          return (
            <div key={column.name} className="contents group/property-row">
              <PropertyLabel column={column} invalid={state.invalid} message={state.message} />
              <div className="min-w-0">
                <PropertyPanelValue
                  column={column}
                  value={values[column.name]}
                  invalid={state.invalid}
                  disabled={state.message === m.property_state_type_conflict()}
                  editing={editingField === column.name}
                  persons={persons}
                  onRequestPersons={loadPersons}
                  onEditChange={(editing) =>
                    setEditingField(editing ? column.name : null)
                  }
                  onValueChange={(value) => onValueChange(column.name, value)}
                />
                {state.invalid ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(column.type === "select" ||
                      column.type === "multi_select" ||
                      column.type === "status") && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => setDialog({ type: "add-option", column })}
                        >
                          {m.property_action_readd_option()}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => void onValueChange(column.name, null)}
                        >
                          {m.property_action_clear_values()}
                        </Button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <ColumnActions column={column} onDialog={setDialog} />
            </div>
          );
        })}

        {orphanEntries.map(([field, value]) => (
          <div key={field} className="contents">
            <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <AlertTriangle className="text-warning" />
                  </TooltipTrigger>
                  <TooltipContent>{m.property_state_orphan()}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <span className="truncate">{field}</span>
            </div>
            <div className="min-w-0 truncate rounded-lg border border-dashed px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {valueToString(value)}
            </div>
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() =>
                  void schemaInvoke("promote_orphan", {
                    entryId: metaId,
                    field,
                  }).catch(handleSchemaError)
                }
              >
                <RotateCcw />
                <span className="sr-only">{m.property_action_readd()}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void onValueChange(field, null)}
              >
                <Trash2 />
                <span className="sr-only">{m.property_action_clear_values()}</span>
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {m.property_collection_path({ path: collectionRootPath })}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ type: "add-column" })}>
          <Plus data-icon="inline-start" />
          {m.editor_frontmatter_add_field()}
        </Button>
      </div>

      <AddColumnDialog
        open={dialog?.type === "add-column"}
        onOpenChange={(open) => !open && setDialog(null)}
        onSubmit={async (column) => {
          await schemaInvoke("add_schema_column", { column }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
      <ChangeTypeDialog
        open={dialog?.type === "change-type"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "change-type" ? dialog.column : null}
        onSubmit={async (newType, conversionStrategy) => {
          if (dialog?.type !== "change-type") return;
          await schemaInvoke("change_schema_type", {
            columnName: dialog.column.name,
            newType,
            conversionStrategy,
          }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
      <RenameColumnDialog
        open={dialog?.type === "rename-column"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "rename-column" ? dialog.column : null}
        onSubmit={async (newName) => {
          if (dialog?.type !== "rename-column") return;
          await schemaInvoke("rename_schema_column", {
            oldName: dialog.column.name,
            newName,
          }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
      <DeleteColumnDialog
        open={dialog?.type === "delete-column"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "delete-column" ? dialog.column : null}
        onSubmit={async (deleteValues) => {
          if (dialog?.type !== "delete-column") return;
          await schemaInvoke("delete_schema_column", {
            columnName: dialog.column.name,
            deleteValues,
          }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
      <AddOptionDialog
        open={dialog?.type === "add-option"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "add-option" ? dialog.column : null}
        onSubmit={async (option) => {
          if (dialog?.type !== "add-option") return;
          await schemaInvoke("add_option", {
            columnName: dialog.column.name,
            option,
          }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
      <RenameOptionDialog
        open={dialog?.type === "rename-option"}
        onOpenChange={(open) => !open && setDialog(null)}
        option={dialog?.type === "rename-option" ? dialog.option : null}
        onSubmit={async (newOptionName) => {
          if (dialog?.type !== "rename-option") return;
          await schemaInvoke("rename_option", {
            columnName: dialog.column.name,
            oldOptionName: dialog.option.name,
            newOptionName,
          }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
      <DeleteOptionDialog
        open={dialog?.type === "delete-option"}
        onOpenChange={(open) => !open && setDialog(null)}
        option={dialog?.type === "delete-option" ? dialog.option : null}
        onSubmit={async (deleteValues) => {
          if (dialog?.type !== "delete-option") return;
          await schemaInvoke("delete_option", {
            columnName: dialog.column.name,
            optionName: dialog.option.name,
            deleteValues,
          }).catch(handleSchemaError);
          setDialog(null);
        }}
      />
    </div>
  );
}

function PropertyPanelValue({
  column,
  value,
  invalid,
  disabled,
  editing,
  persons,
  onRequestPersons,
  onEditChange,
  onValueChange,
}: {
  column: Column;
  value: unknown;
  invalid: boolean;
  disabled: boolean;
  editing: boolean;
  persons: Person[];
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  onEditChange: (editing: boolean) => void;
  onValueChange: (value: unknown) => Promise<void>;
}) {
  if (editing) {
    return (
      <div
        className="min-w-0"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onEditChange(false);
          }
        }}
      >
        <PropertyControl
          column={column}
          value={value}
          invalid={invalid}
          disabled={disabled}
          autoOpen
          persons={persons}
          onRequestPersons={onRequestPersons}
          onChange={(nextValue) => {
            const close = shouldClosePropertyEditorOnChange(column.type);
            const saved = onValueChange(nextValue);
            if (close) void saved.finally(() => onEditChange(false));
            return saved;
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        invalid && "ring-1 ring-warning",
      )}
      onClick={() => onEditChange(true)}
    >
      <span className="min-w-0 flex-1">
        <PropertyValue column={column} value={value} />
      </span>
    </button>
  );
}

function PropertyLabel({
  column,
  invalid,
  message,
}: {
  column: Column;
  invalid: boolean;
  message?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
      {invalid ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className="text-warning" />
            </TooltipTrigger>
            <TooltipContent>{message}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      <span className="truncate">{column.name}</span>
    </div>
  );
}

function ColumnActions({
  column,
  onDialog,
}: {
  column: Column;
  onDialog: (dialog: DialogState) => void;
}) {
  const hasOptions =
    column.type === "select" || column.type === "multi_select" || column.type === "status";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="opacity-0 transition-opacity group-hover/property-row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal />
          <span className="sr-only">{m.common_settings()}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onDialog({ type: "rename-column", column })}>
          {m.space_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDialog({ type: "change-type", column })}>
          {m.property_action_change_type()}
        </DropdownMenuItem>
        {hasOptions ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onDialog({ type: "add-option", column })}>
              {m.property_action_add_option()}
            </DropdownMenuItem>
            {(column.options ?? []).map((option) => (
              <DropdownMenuItem
                key={option.name}
                onSelect={() => onDialog({ type: "rename-option", column, option })}
              >
                {m.property_action_rename_option({ name: option.name })}
              </DropdownMenuItem>
            ))}
            {(column.options ?? []).map((option) => (
              <DropdownMenuItem
                key={`delete-${option.name}`}
                variant="destructive"
                onSelect={() => onDialog({ type: "delete-option", column, option })}
              >
                {m.property_action_delete_option({ name: option.name })}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onDialog({ type: "delete-column", column })}
        >
          {m.file_delete_confirm()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function handleSchemaError(error: unknown) {
  console.error("Schema operation failed:", error);
  toast.error(m.toast_error());
}

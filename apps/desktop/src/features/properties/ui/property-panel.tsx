import { useState } from "react";
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
import { cn } from "@/shared/lib/utils";
import {
  AlertTriangle,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  ActorCandidate,
  Column,
  EntrySchemaResult,
  PropertyOption,
  RelationContext,
} from "../model/types";
import {
  shouldClosePropertyEditorOnChange,
  validatePropertyValue,
} from "../model/validation";
import { PropertyControl } from "./property-control";
import { PropertyValue } from "./property-value";
import { propertyValidationMessage } from "./validation-message";
import {
  AddColumnDialog,
  AddOptionDialog,
  ChangeTypeDialog,
  DeleteColumnDialog,
  DeleteOptionDialog,
  RenameColumnDialog,
  RenameOptionDialog,
} from "./schema-dialogs";
import { usePropertyPanelState } from "../hooks/use-property-panel-state";
import { hasOption, valueToString } from "../lib/utils";
import * as m from "@/paraglide/messages.js";

interface PropertyPanelProps {
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  filePath: string;
  schemaResult: EntrySchemaResult;
  values: Record<string, unknown>;
  mode?: "peek" | "full";
  onOpenPath?: (path: string, spaceId?: string | null) => void;
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
  spaceId,
  filePath,
  schemaResult,
  values,
  mode = "peek",
  onOpenPath,
  onValueChange,
  onSchemaChange,
}: PropertyPanelProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const {
    schema,
    collectionRootPath,
    actors,
    editingField,
    setEditingField,
    panelValues,
    orphanEntries,
    relationContext,
    loadActors,
    handleSchemaError,
    assignUniqueId,
    addColumn,
    changeColumnType,
    renameColumn,
    deleteColumn,
    addOption,
    renameOption,
    deleteOption,
    promoteOrphan,
    clearOrphanValues,
    clearInvalidOptionValues,
  } = usePropertyPanelState({
    spacePath,
    projectPath,
    spaceId,
    filePath,
    schemaResult,
    values,
    onOpenPath,
    onSchemaChange,
  });

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
          const state = validatePropertyValue(column, panelValues[column.name]);
          const validationMessage = propertyValidationMessage(state.code);
          const invalidOptions = invalidOptionValues(
            column,
            panelValues[column.name],
          );
          return (
            <div key={column.name} className="contents group/property-row">
              <PropertyLabel
                column={column}
                invalid={state.invalid}
                message={validationMessage}
              />
              <div className="min-w-0">
                <PropertyPanelValue
                  column={column}
                  value={panelValues[column.name]}
                  invalid={state.invalid}
                  disabled={state.code === "type_conflict"}
                  editing={editingField === column.name}
                  actors={actors}
                  relationContext={relationContext}
                  onRequestActors={loadActors}
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
                          onClick={() =>
                            setDialog({ type: "add-option", column })
                          }
                        >
                          {m.property_action_readd_option()}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            void (
                              invalidOptions.length > 0
                                ? clearInvalidOptionValues(
                                    column,
                                    invalidOptions,
                                  )
                                : onValueChange(column.name, null)
                            ).catch(handleSchemaError)
                          }
                        >
                          {m.property_action_clear_values()}
                        </Button>
                      </>
                    )}
                    {column.type === "unique_id" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => void assignUniqueId()}
                      >
                        {m.property_action_assign_key()}
                      </Button>
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
                onClick={() => void promoteOrphan(field)}
              >
                <RotateCcw />
                <span className="sr-only">{m.property_action_readd()}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void clearOrphanValues(field)}
              >
                <Trash2 />
                <span className="sr-only">
                  {m.property_action_clear_values()}
                </span>
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {m.property_collection_path({ path: collectionRootPath })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDialog({ type: "add-column" })}
        >
          <Plus data-icon="inline-start" />
          {m.editor_frontmatter_add_field()}
        </Button>
      </div>

      <AddColumnDialog
        open={dialog?.type === "add-column"}
        onOpenChange={(open) => !open && setDialog(null)}
        collectionPath={collectionRootPath}
        onSubmit={async (column) => {
          await addColumn(column);
          setDialog(null);
        }}
      />
      <ChangeTypeDialog
        open={dialog?.type === "change-type"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "change-type" ? dialog.column : null}
        collectionPath={collectionRootPath}
        onSubmit={async (newType, conversionStrategy) => {
          if (dialog?.type !== "change-type") return;
          if (
            await changeColumnType(dialog.column, newType, conversionStrategy)
          ) {
            setDialog(null);
          }
        }}
      />
      <RenameColumnDialog
        open={dialog?.type === "rename-column"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "rename-column" ? dialog.column : null}
        onSubmit={async (newName) => {
          if (dialog?.type !== "rename-column") return;
          await renameColumn(dialog.column, newName);
          setDialog(null);
        }}
      />
      <DeleteColumnDialog
        open={dialog?.type === "delete-column"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "delete-column" ? dialog.column : null}
        onSubmit={async (deleteValues) => {
          if (dialog?.type !== "delete-column") return;
          await deleteColumn(dialog.column, deleteValues);
          setDialog(null);
        }}
      />
      <AddOptionDialog
        open={dialog?.type === "add-option"}
        onOpenChange={(open) => !open && setDialog(null)}
        column={dialog?.type === "add-option" ? dialog.column : null}
        onSubmit={async (option) => {
          if (dialog?.type !== "add-option") return;
          await addOption(dialog.column, option);
          setDialog(null);
        }}
      />
      <RenameOptionDialog
        open={dialog?.type === "rename-option"}
        onOpenChange={(open) => !open && setDialog(null)}
        option={dialog?.type === "rename-option" ? dialog.option : null}
        onSubmit={async (newOptionName) => {
          if (dialog?.type !== "rename-option") return;
          await renameOption(dialog.column, dialog.option, newOptionName);
          setDialog(null);
        }}
      />
      <DeleteOptionDialog
        open={dialog?.type === "delete-option"}
        onOpenChange={(open) => !open && setDialog(null)}
        option={dialog?.type === "delete-option" ? dialog.option : null}
        onSubmit={async (deleteValues) => {
          if (dialog?.type !== "delete-option") return;
          await deleteOption(dialog.column, dialog.option, deleteValues);
          setDialog(null);
        }}
      />
    </div>
  );
}

function invalidOptionValues(column: Column, value: unknown): string[] {
  if (
    column.type !== "select" &&
    column.type !== "multi_select" &&
    column.type !== "status"
  ) {
    return [];
  }

  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  return Array.from(
    new Set(raw.filter((item) => item && !hasOption(column, item))),
  );
}

function PropertyPanelValue({
  column,
  value,
  invalid,
  disabled,
  editing,
  actors,
  relationContext,
  onRequestActors,
  onEditChange,
  onValueChange,
}: {
  column: Column;
  value: unknown;
  invalid: boolean;
  disabled: boolean;
  editing: boolean;
  actors: ActorCandidate[];
  relationContext: RelationContext;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
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
          actors={actors}
          relationContext={relationContext}
          onRequestActors={onRequestActors}
          onChange={(nextValue) => {
            const close = shouldClosePropertyEditorOnChange(column.type);
            const saved = onValueChange(nextValue);
            if (close) void saved.finally(() => onEditChange(false));
            return saved;
          }}
          onOpenChange={(open) => {
            if (!open) window.setTimeout(() => onEditChange(false), 0);
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        disabled && "pointer-events-none opacity-50",
        invalid && "ring-1 ring-warning",
      )}
      onClick={() => {
        if (!disabled && column.type !== "unique_id") onEditChange(true);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onEditChange(true);
        }
      }}
    >
      <span className="min-w-0 flex-1">
        <PropertyValue
          column={column}
          value={value}
          actors={actors}
          relationContext={relationContext}
        />
      </span>
    </div>
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
    column.type === "select" ||
    column.type === "multi_select" ||
    column.type === "status";
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
        <DropdownMenuItem
          onSelect={() => onDialog({ type: "rename-column", column })}
        >
          {m.space_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onDialog({ type: "change-type", column })}
        >
          {m.property_action_change_type()}
        </DropdownMenuItem>
        {hasOptions ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onDialog({ type: "add-option", column })}
            >
              {m.property_action_add_option()}
            </DropdownMenuItem>
            {(column.options ?? []).map((option) => (
              <DropdownMenuItem
                key={option.name}
                onSelect={() =>
                  onDialog({ type: "rename-option", column, option })
                }
              >
                {m.property_action_rename_option({ name: option.name })}
              </DropdownMenuItem>
            ))}
            {(column.options ?? []).map((option) => (
              <DropdownMenuItem
                key={`delete-${option.name}`}
                variant="destructive"
                onSelect={() =>
                  onDialog({ type: "delete-option", column, option })
                }
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

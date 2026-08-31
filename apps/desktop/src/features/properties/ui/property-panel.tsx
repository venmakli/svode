import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { AlertTriangle, Plus, RotateCcw, Trash2 } from "lucide-react";
import type {
  ActorCandidate,
  Column,
  PageSchemaResult,
  RelationContext,
} from "../model/types";
import {
  shouldClosePropertyEditorOnChange,
  validatePropertyValue,
} from "../model/validation";
import { PropertyControl } from "./property-control";
import { PropertyValue } from "./property-value";
import { propertyValidationMessage } from "./validation-message";
import { AddColumnDialog, AddOptionDialog } from "./schema-dialogs";
import { PropertyLabelTrigger, SchemaColumnMenu } from "./schema-column-menu";
import { usePropertyPanelState } from "../hooks/use-property-panel-state";
import { hasOption, valueToString } from "../lib/utils";
import * as m from "@/paraglide/messages.js";

interface PropertyPanelProps {
  spacePath: string;
  projectPath?: string | null;
  spaceId?: string | null;
  filePath: string;
  pageLabel: string;
  schemaResult: PageSchemaResult;
  values: Record<string, unknown>;
  mode?: "peek" | "full";
  readOnly?: boolean;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
  onValueChange: (field: string, value: unknown) => Promise<void>;
  onSchemaChange?: (result: PageSchemaResult | null) => void;
}

type DialogState =
  | { type: "add-column" }
  | { type: "add-option"; column: Column }
  | null;

export function PropertyPanel({
  spacePath,
  projectPath,
  spaceId,
  filePath,
  pageLabel,
  schemaResult,
  values,
  mode = "peek",
  readOnly = false,
  onOpenPath,
  onValueChange,
  onSchemaChange,
}: PropertyPanelProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [openColumn, setOpenColumn] = useState<string | null>(null);
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
    applyCollectionSchema,
    assignUniqueId,
    addColumn,
    addOption,
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
            ? "grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] md:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_minmax(7rem,12rem)_minmax(0,1fr)]"
            : "grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)]",
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
            <div key={column.name} className="contents">
              <PropertyLabel
                schemaMenu={
                  readOnly ? (
                    <PropertyLabelTrigger
                      column={column}
                      open={false}
                      disabled
                    />
                  ) : (
                    <SchemaColumnMenu
                      trigger={
                        <PropertyLabelTrigger
                          column={column}
                          open={openColumn === column.name}
                        />
                      }
                      open={openColumn === column.name}
                      column={column}
                      schema={schema}
                      collectionPath={collectionRootPath}
                      spacePath={spacePath}
                      projectPath={projectPath}
                      onOpenChange={(open) =>
                        setOpenColumn(open ? column.name : null)
                      }
                      onSchemaChange={applyCollectionSchema}
                    />
                  )
                }
                invalid={state.invalid}
                message={validationMessage}
              />
              <div className="min-w-0">
                <PropertyPanelValue
                  column={column}
                  pageLabel={pageLabel}
                  value={panelValues[column.name]}
                  invalid={state.invalid}
                  disabled={state.code === "type_conflict"}
                  readOnly={readOnly}
                  editing={editingField === column.name}
                  actors={actors}
                  relationContext={relationContext}
                  onRequestActors={loadActors}
                  onEditChange={(editing) =>
                    setEditingField(editing ? column.name : null)
                  }
                  onValueChange={(value) => onValueChange(column.name, value)}
                />
                {state.invalid && !readOnly ? (
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
            <div className="flex min-w-0 items-center gap-1">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-dashed px-2 py-1.5 font-mono text-xs text-muted-foreground">
                {valueToString(value)}
              </div>
              {!readOnly ? (
                <div className="flex shrink-0 items-center gap-1">
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
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {m.property_collection_path({ path: collectionRootPath })}
        </span>
        {!readOnly ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDialog({ type: "add-column" })}
          >
            <Plus data-icon="inline-start" />
            {m.editor_frontmatter_add_field()}
          </Button>
        ) : null}
      </div>

      {!readOnly ? (
        <AddColumnDialog
          open={dialog?.type === "add-column"}
          onOpenChange={(open) => !open && setDialog(null)}
          collectionPath={collectionRootPath}
          onSubmit={async (column) => {
            await addColumn(column);
            setDialog(null);
          }}
        />
      ) : null}
      {!readOnly ? (
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
      ) : null}
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
  pageLabel,
  value,
  invalid,
  disabled,
  readOnly,
  editing,
  actors,
  relationContext,
  onRequestActors,
  onEditChange,
  onValueChange,
}: {
  column: Column;
  pageLabel: string;
  value: unknown;
  invalid: boolean;
  disabled: boolean;
  readOnly: boolean;
  editing: boolean;
  actors: ActorCandidate[];
  relationContext: RelationContext;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onEditChange: (editing: boolean) => void;
  onValueChange: (value: unknown) => Promise<void>;
}) {
  if (readOnly) {
    return (
      <div className="flex min-h-8 w-full min-w-0 items-center px-2 py-1.5 text-sm">
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
          accessibilityLabel={`${column.name}: ${pageLabel}`}
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
  schemaMenu,
  invalid,
  message,
}: {
  schemaMenu: ReactNode;
  invalid: boolean;
  message?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
      <div className="min-w-0 flex-1">{schemaMenu}</div>
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
    </div>
  );
}

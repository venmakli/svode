import { useState, type ReactNode } from "react";
import { AlertTriangle, Plus, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import type { CollectionSchemaPanel } from "../hooks/use-collection-schema-panel";
import { hasOption, valueToString } from "../lib/utils";
import type { Column } from "../model/types";
import type { PropertyValidationState } from "../model/validation";
import { NewerPropertyLabel } from "./newer-property";
import { PropertyAddTypeMenu } from "./property-add-type-menu";
import { AddOptionDialog } from "./schema-dialogs";
import { PropertyLabelTrigger, SchemaColumnMenu } from "./schema-column-menu";
import { propertyValidationMessage } from "./validation-message";

/**
 * The label of a schema property: its column menu, disabled in read-only
 * mode, or the explanation of a property of a newer Svode version; an
 * invalid saved value shows its reason next to it. It is centred on the
 * first line of its value: stretched over its grid row no higher than that
 * line, a line of text or, `besideControl`, a control under the padding of
 * the value cell, so a taller value or neighbouring cell leaves it at the
 * top of the row.
 */
export function SchemaPropertyLabel({
  besideControl = false,
  column,
  readOnly,
  schemaPanel,
  validation,
}: {
  besideControl?: boolean;
  column: Column;
  readOnly: boolean;
  schemaPanel: CollectionSchemaPanel;
  validation: PropertyValidationState;
}) {
  const open = schemaPanel.openColumn === column.name;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 text-sm text-muted-foreground",
        besideControl ? "max-h-11" : "max-h-8",
      )}
    >
      <div className="min-w-0 flex-1">
        {column.newer ? (
          <NewerPropertyLabel column={column} />
        ) : readOnly ? (
          <PropertyLabelTrigger column={column} open={false} disabled />
        ) : (
          <SchemaColumnMenu
            trigger={<PropertyLabelTrigger column={column} open={open} />}
            open={open}
            column={column}
            schema={schemaPanel.schema}
            collectionPath={schemaPanel.collectionRootPath}
            spacePath={schemaPanel.spacePath}
            projectPath={schemaPanel.projectPath}
            onOpenChange={(next) =>
              schemaPanel.setOpenColumn(next ? column.name : null)
            }
            onSchemaChange={schemaPanel.applyCollectionSchema}
          />
        )}
      </div>
      {validation.invalid ? (
        <PropertyProblemIcon
          message={propertyValidationMessage(validation.code)}
          detail={validation.duplicate?.title || undefined}
        />
      ) : null}
    </div>
  );
}

function PropertyProblemIcon({
  message,
  detail,
}: {
  message?: string;
  detail?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertTriangle className="text-warning" />
        </TooltipTrigger>
        <TooltipContent>
          {detail ? (
            <span className="flex flex-col">
              <span>{message}</span>
              <span className="opacity-70">{detail}</span>
            </span>
          ) : (
            message
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The repairs of an invalid saved value under it: an option the schema lost
 * is added back or its values cleared, and an item without a valid number
 * gets a new key.
 */
export function SchemaValueRepair({
  column,
  value,
  schemaPanel,
  onAddOption,
  onClearValue,
}: {
  column: Column;
  value: unknown;
  schemaPanel: CollectionSchemaPanel;
  onAddOption: () => void;
  onClearValue: () => Promise<void>;
}) {
  const options =
    column.type === "select" ||
    column.type === "multi_select" ||
    column.type === "status";
  if (!options && column.type !== "unique_id") return null;
  const invalidOptions = options ? invalidOptionValues(column, value) : [];
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {options ? (
        <>
          <Button type="button" variant="ghost" size="xs" onClick={onAddOption}>
            {m.property_action_readd_option()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() =>
              void (
                invalidOptions.length > 0
                  ? schemaPanel.clearInvalidOptionValues(column, invalidOptions)
                  : onClearValue()
              ).catch(schemaPanel.handleSchemaError)
            }
          >
            {m.property_action_clear_values()}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void schemaPanel.assignUniqueId()}
        >
          {m.property_action_assign_key()}
        </Button>
      )}
    </div>
  );
}

/** The item's values that no property of the schema declares. */
export function SchemaOrphanRows({
  readOnly,
  schemaPanel,
  renderRow,
}: {
  readOnly: boolean;
  schemaPanel: CollectionSchemaPanel;
  renderRow: (row: {
    key: string;
    label: ReactNode;
    value: ReactNode;
  }) => ReactNode;
}) {
  return schemaPanel.orphanEntries.map(([field, value]) =>
    renderRow({
      key: field,
      label: (
        <div className="flex min-w-0 items-center gap-1 px-1.5 text-sm text-muted-foreground">
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
      ),
      value: (
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
                onClick={() => void schemaPanel.promoteOrphan(field)}
              >
                <RotateCcw />
                <span className="sr-only">{m.property_action_readd()}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void schemaPanel.clearOrphanValues(field)}
              >
                <Trash2 />
                <span className="sr-only">
                  {m.property_action_clear_values()}
                </span>
              </Button>
            </div>
          ) : null}
        </div>
      ),
    }),
  );
}

/**
 * "+ Add property" under the properties: the shared menu of property types,
 * after which the new property's column menu opens with its name in focus.
 */
export function SchemaAddPropertyAction({
  schemaPanel,
}: {
  schemaPanel: CollectionSchemaPanel;
}) {
  return (
    <PropertyAddTypeMenu
      trigger={
        <Button
          type="button"
          variant="ghost"
          className="w-fit justify-start gap-1.5 px-1.5 font-normal text-muted-foreground"
        >
          <Plus data-icon="inline-start" />
          {m.collection_add_property()}
        </Button>
      }
      columns={schemaPanel.schema.columns}
      align="start"
      onSelect={(type) => void schemaPanel.addProperty(type)}
    />
  );
}

/** Adds an option back to a column whose values lost it. */
export function useSchemaAddOptionDialog(
  schemaPanel: CollectionSchemaPanel | undefined,
) {
  const [column, setColumn] = useState<Column | null>(null);
  return {
    open: setColumn,
    dialog: (
      <AddOptionDialog
        open={column !== null}
        onOpenChange={(open) => !open && setColumn(null)}
        column={column}
        onSubmit={async (option) => {
          if (!column || !schemaPanel) return;
          await schemaPanel.addOption(column, option);
          setColumn(null);
        }}
      />
    ),
  };
}

function invalidOptionValues(column: Column, value: unknown): string[] {
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

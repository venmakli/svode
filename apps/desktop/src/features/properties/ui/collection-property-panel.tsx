import { Fragment, type ReactNode } from "react";
import { Folder, SquareTerminal, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

import type { CollectionSchemaPanel } from "../hooks/use-collection-schema-panel";
import { isEmptyValue } from "../lib/utils";
import {
  resolveStandardPropertyColumn,
  type CollectionPropertyDefinition,
} from "../model/collection-property";
import type {
  CollectionPropertyConflictEntry,
  CollectionPropertyPanelConflict,
} from "../model/collection-property-conflict";
import type { Column } from "../model/types";
import {
  isEmptyCollectionPropertyFact,
  type CollectionPropertyFactGroup,
  type CollectionPropertyFactValue,
} from "../model/collection-property-fact";
import {
  validatePropertyValue,
  type PropertyValidationState,
} from "../model/validation";
import {
  CollectionPropertyValue,
  readCollectionPropertyApplicability,
} from "./collection-property-value";
import {
  CollectionPropertyEditor,
  readCollectionPropertyEditState,
} from "./collection-property-editor";
import {
  SchemaAddPropertyAction,
  SchemaOrphanRows,
  SchemaPropertyLabel,
  SchemaValueRepair,
  useSchemaAddOptionDialog,
} from "./collection-property-panel-schema";
import {
  ConflictDecision,
  ConflictLabel,
  ConflictSummary,
} from "./collection-property-conflict";
import { PROPERTY_TYPE_ICONS } from "./property-type-meta";

const VALID: PropertyValidationState = { invalid: false };

/**
 * The properties of one item, built from the same property definitions as
 * the columns of its Collection in their order, followed by the item's facts
 * under their group labels. "Name" is not repeated: the content header says
 * it. A hidden property is not shown, nor an empty read-only property or
 * fact; an empty editable property shows its hint. A property its owner
 * declared editable is edited here with the control of its cell, see
 * `CollectionPropertyEditor`; `readOnly` shows every value without editing.
 *
 * An item of a Collection with a schema adds the schema extensions of
 * `schemaPanel`: the column menu at the label of each schema property, which
 * stays shown while it can be edited, the state of an invalid saved value
 * with its repair, "Number repeats" of a `unique_id`, the values the schema
 * does not declare and "+ Add property", alone while the schema has no
 * properties.
 *
 * In the conflict mode of `conflict` the panel shows the merged values read
 * only, under one line about the conflict; a disputed property is shown even
 * when it is hidden or empty, with the conflict mark, its control and the
 * variants of the sides, and a disputed key without a property comes first
 * with its value as text. The schema cannot be edited meanwhile.
 */
export function CollectionPropertyPanel<Item>({
  conflict,
  factGroups = [],
  properties,
  item,
  layout = "default",
  readOnly = false,
  schemaPanel,
}: {
  conflict?: CollectionPropertyPanelConflict<Item>;
  factGroups?: readonly CollectionPropertyFactGroup[];
  properties: readonly CollectionPropertyDefinition<Item>[];
  item: Item;
  /** `wide` puts two properties in a row from the medium width up. */
  layout?: "default" | "wide";
  readOnly?: boolean;
  schemaPanel?: CollectionSchemaPanel;
}) {
  const optionDialog = useSchemaAddOptionDialog(schemaPanel);
  const disputed = new Map(
    conflict?.disputed.map((entry) => [entry.key, entry]),
  );
  const schemaReadOnly = readOnly || Boolean(conflict);
  const extraEntries = conflict
    ? conflict.disputed.filter(
        (entry) =>
          !properties.some(
            (property) =>
              property.common !== "title" &&
              propertyKey(property) === entry.key,
          ),
      )
    : [];
  const rows = properties.flatMap((property): PanelRowModel<Item>[] => {
    if (property.common === "title") return [];
    const schemaColumn =
      schemaPanel && property.owner.kind === "schema"
        ? property.owner.column
        : null;
    const entry = disputed.get(propertyKey(property));
    if (entry) {
      return [
        {
          kind: readOnly || conflict?.readOnly ? "value" : "edit",
          property,
          schemaColumn,
          validation: VALID,
          entry,
        },
      ];
    }
    const validation = schemaColumn
      ? validatePropertyValue(
          schemaColumn,
          readValue(property, item),
          schemaPanel?.uniqueIdDuplicate,
        )
      : VALID;
    const kind = panelRowKind(property, item, {
      // The merged values of a conflict are read only until written.
      readOnly: schemaReadOnly,
      // A schema property keeps its row, and its column menu, while the
      // schema can be edited; an invalid value shows its state anyway.
      keep: schemaColumn !== null && (!schemaReadOnly || validation.invalid),
    });
    return kind ? [{ kind, property, schemaColumn, validation }] : [];
  });
  const visibleGroups = factGroups
    .map((group) => ({
      ...group,
      facts: group.facts.filter((fact) => !isEmptyCollectionPropertyFact(fact)),
    }))
    .filter((group) => group.facts.length > 0);
  const addAction =
    schemaPanel && !schemaReadOnly ? (
      <SchemaAddPropertyAction schemaPanel={schemaPanel} />
    ) : null;
  const summary = conflict ? <ConflictSummary conflict={conflict} /> : null;
  const orphanCount = schemaPanel?.orphanEntries.length ?? 0;
  if (
    !conflict &&
    ((schemaPanel && schemaPanel.schema.columns.length === 0) ||
      (rows.length === 0 && visibleGroups.length === 0 && orphanCount === 0))
  ) {
    // A Collection without properties offers only the first one to add.
    return addAction;
  }
  const renderConflictValue =
    (property: CollectionPropertyDefinition<Item> | null) =>
    (variantItem: Item, text: string) =>
      property ? (
        <CollectionPropertyValue
          context="detail"
          property={property as CollectionPropertyDefinition<unknown>}
          item={variantItem}
          relationContext={schemaPanel?.relationContext}
        />
      ) : (
        <ConflictText text={text} />
      );

  const grid = (
    <div
      className={cn(
        "grid max-w-5xl min-w-0 grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] gap-x-6 gap-y-0.5",
        layout === "wide" &&
          "md:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_minmax(7rem,12rem)_minmax(0,1fr)]",
      )}
      data-collection-property-panel
    >
      {conflict
        ? extraEntries.map((entry) => (
            <PanelRow
              key={`conflict:${entry.key}`}
              label={
                <ConflictLabel>
                  <PanelLabel
                    icon={PROPERTY_TYPE_ICONS.text}
                    label={entry.label}
                  />
                </ConflictLabel>
              }
              rowAttributes={{ "data-collection-panel-property": entry.key }}
            >
              {entry.decision ? (
                <ConflictText text={entry.decidedText} />
              ) : null}
              <ConflictDecision
                conflict={conflict}
                entry={entry}
                renderValue={renderConflictValue(null)}
              />
            </PanelRow>
          ))
        : null}
      {rows.map(({ kind, property, schemaColumn, validation, entry }) => {
        const column = resolveStandardPropertyColumn(property);
        const edit = property.capabilities?.edit;
        const label =
          schemaColumn && schemaPanel ? (
            <SchemaPropertyLabel
              column={schemaColumn}
              readOnly={schemaReadOnly}
              schemaPanel={schemaPanel}
              validation={validation}
            />
          ) : (
            <PanelLabel
              icon={PROPERTY_TYPE_ICONS[column?.type ?? "text"]}
              label={property.label}
            />
          );
        return (
          <PanelRow
            key={`property:${property.key}`}
            label={entry ? <ConflictLabel>{label}</ConflictLabel> : label}
            rowAttributes={{ "data-collection-panel-property": property.key }}
          >
            {edit && kind === "edit" ? (
              <CollectionPropertyEditor
                // A decision by a side draws the control again with its value.
                key={entry ? `${entry.decision ?? "open"}` : undefined}
                column={column}
                disabled={validation.code === "type_conflict"}
                edit={edit}
                invalid={validation.invalid}
                item={item}
                property={property}
                relationContext={schemaPanel?.relationContext}
                onRequestActors={schemaPanel?.loadActors}
              />
            ) : !entry || entry.decision ? (
              <CollectionPropertyValue
                context="detail"
                property={property as CollectionPropertyDefinition<unknown>}
                item={item}
                relationContext={schemaPanel?.relationContext}
              />
            ) : null}
            {entry && conflict ? (
              <ConflictDecision
                conflict={conflict}
                entry={entry}
                renderValue={renderConflictValue(property)}
              />
            ) : null}
            {schemaColumn &&
            schemaPanel &&
            validation.invalid &&
            !schemaReadOnly ? (
              <SchemaValueRepair
                column={schemaColumn}
                value={readValue(property, item)}
                schemaPanel={schemaPanel}
                onAddOption={() => optionDialog.open(schemaColumn)}
                onClearValue={async () => {
                  await edit?.update(item, null);
                }}
              />
            ) : null}
          </PanelRow>
        );
      })}
      {schemaPanel ? (
        <SchemaOrphanRows
          readOnly={schemaReadOnly}
          schemaPanel={schemaPanel}
          renderRow={({ key, label, value }) => (
            <PanelRow
              key={`orphan:${key}`}
              label={label}
              rowAttributes={{ "data-collection-panel-orphan": key }}
            >
              {value}
            </PanelRow>
          )}
        />
      ) : null}
      {visibleGroups.map((group) => (
        <Fragment key={`group:${group.key}`}>
          {group.label ? (
            <h3
              className="col-span-full px-1.5 pt-3 pb-1 text-xs font-medium text-muted-foreground"
              data-collection-panel-fact-group={group.key}
            >
              {group.label}
            </h3>
          ) : null}
          {group.facts.map((fact) => (
            <PanelRow
              key={`fact:${group.key}:${fact.key}`}
              label={
                <PanelLabel
                  icon={fact.icon ?? factValueIcon(fact.value)}
                  label={fact.label}
                />
              }
              rowAttributes={{ "data-collection-panel-fact": fact.key }}
            >
              <FactValue value={fact.value} />
            </PanelRow>
          ))}
        </Fragment>
      ))}
    </div>
  );
  if (!schemaPanel && !summary) return grid;
  return (
    <div className="flex flex-col gap-2">
      {summary}
      {grid}
      {addAction}
      {schemaReadOnly ? null : optionDialog.dialog}
    </div>
  );
}

interface PanelRowModel<Item> {
  kind: "edit" | "value";
  property: CollectionPropertyDefinition<Item>;
  schemaColumn: Column | null;
  validation: PropertyValidationState;
  /** The property is disputed in conflict mode. */
  entry?: CollectionPropertyConflictEntry<Item>;
}

/** The key of the item's values a property shows. */
function propertyKey<Item>(property: CollectionPropertyDefinition<Item>) {
  return property.owner.kind === "schema"
    ? property.owner.column.name
    : property.key;
}

function ConflictText({ text }: { text: string }) {
  return text ? (
    <span className="block min-w-0 whitespace-pre-wrap break-words select-text [overflow-wrap:anywhere]">
      {text}
    </span>
  ) : (
    <span className="text-muted-foreground">-</span>
  );
}

function readValue<Item>(
  property: CollectionPropertyDefinition<Item>,
  item: Item,
): unknown {
  try {
    return property.getValue(item);
  } catch {
    return undefined;
  }
}

/**
 * How the panel shows a property of the item: editable where its owner
 * declared editing, as a value otherwise; null when it is not shown.
 */
function panelRowKind<Item>(
  property: CollectionPropertyDefinition<Item>,
  item: Item,
  { keep, readOnly }: { keep: boolean; readOnly: boolean },
): "edit" | "value" | null {
  const applicability = readCollectionPropertyApplicability(
    property as CollectionPropertyDefinition<unknown>,
    item,
  );
  if (applicability.status === "hidden") return null;
  if (applicability.status === "unavailable") return "value";
  const edit = readOnly ? undefined : property.capabilities?.edit;
  const hasEditor = Boolean(
    edit && (edit.popover || resolveStandardPropertyColumn(property)),
  );
  // An empty property shows its hint only while it can be edited.
  if (
    hasEditor &&
    readCollectionPropertyEditState(edit!, item).status !== "disabled"
  ) {
    return "edit";
  }
  if (!keep && isEmptyPanelValue(property, item)) return null;
  return hasEditor ? "edit" : "value";
}

function isEmptyPanelValue<Item>(
  property: CollectionPropertyDefinition<Item>,
  item: Item,
): boolean {
  try {
    const value = property.getValue(item);
    const display =
      property.semantics.kind === "custom"
        ? property.semantics
        : property.semantics.display;
    // The owner's render decides, as it may show more than the value.
    const render = display?.renderDetail ?? display?.render;
    if (!render) return isEmptyValue(value);
    const rendered = render(value, item);
    return (
      rendered === null ||
      rendered === undefined ||
      rendered === false ||
      rendered === ""
    );
  } catch {
    return false;
  }
}

function PanelRow({
  children,
  label,
  rowAttributes,
}: {
  children: ReactNode;
  label: ReactNode;
  rowAttributes: Record<string, string>;
}) {
  return (
    <div className="contents" {...rowAttributes}>
      {label}
      <div className="flex min-w-0 items-start px-2 py-1.5 text-sm leading-5">
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

function PanelLabel({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 px-1.5 py-1.5 text-sm leading-5 text-muted-foreground">
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        {label}
      </span>
    </div>
  );
}

function FactValue({ value }: { value: CollectionPropertyFactValue }) {
  if (value.kind === "text") {
    return (
      <span className="block min-w-0 whitespace-pre-wrap break-words select-text [overflow-wrap:anywhere]">
        {value.text}
      </span>
    );
  }
  if (value.kind === "list") {
    return (
      <div className="flex min-w-0 flex-wrap gap-1">
        {value.items.map((item, index) => (
          <Badge
            key={`${index}:${item}`}
            className="h-auto max-w-full whitespace-normal font-mono font-normal select-text [overflow-wrap:anywhere]"
            variant="outline"
          >
            {item}
          </Badge>
        ))}
      </div>
    );
  }
  if (value.kind === "link") {
    return (
      <Button
        className="h-auto p-0 text-sm"
        type="button"
        variant="link"
        onClick={value.onSelect}
      >
        {value.label}
      </Button>
    );
  }
  return (
    <code className="block min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-5 select-text">
      {value.kind === "path" ? value.path : value.code}
    </code>
  );
}

function factValueIcon(value: CollectionPropertyFactValue): LucideIcon {
  if (value.kind === "list") return PROPERTY_TYPE_ICONS.multi_select;
  if (value.kind === "link") return PROPERTY_TYPE_ICONS.url;
  if (value.kind === "path") return Folder;
  if (value.kind === "code") return SquareTerminal;
  return PROPERTY_TYPE_ICONS.text;
}

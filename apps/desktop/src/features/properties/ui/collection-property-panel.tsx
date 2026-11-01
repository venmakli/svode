import { Fragment, type ReactNode } from "react";
import { Folder, SquareTerminal, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { isEmptyValue } from "../lib/utils";
import {
  resolveStandardPropertyColumn,
  type CollectionPropertyDefinition,
} from "../model/collection-property";
import {
  isEmptyCollectionPropertyFact,
  type CollectionPropertyFactGroup,
  type CollectionPropertyFactValue,
} from "../model/collection-property-fact";
import {
  CollectionPropertyValue,
  readCollectionPropertyApplicability,
} from "./collection-property-value";
import {
  CollectionPropertyEditor,
  readCollectionPropertyEditState,
} from "./collection-property-editor";
import { PROPERTY_TYPE_ICONS } from "./property-type-meta";

/**
 * The properties of one item, built from the same property definitions as
 * the columns of its Collection in their order, followed by the item's facts
 * under their group labels. "Name" is not repeated: the content header says
 * it. A hidden property is not shown, nor an empty read-only property or
 * fact; an empty editable property shows its hint. A property its owner
 * declared editable is edited here with the control of its cell, see
 * `CollectionPropertyEditor`.
 */
export function CollectionPropertyPanel<Item>({
  factGroups = [],
  properties,
  item,
}: {
  factGroups?: readonly CollectionPropertyFactGroup[];
  properties: readonly CollectionPropertyDefinition<Item>[];
  item: Item;
}) {
  const visibleProperties = properties.filter(
    (property) =>
      property.common !== "title" && panelRowKind(property, item) !== null,
  );
  const visibleGroups = factGroups
    .map((group) => ({
      ...group,
      facts: group.facts.filter((fact) => !isEmptyCollectionPropertyFact(fact)),
    }))
    .filter((group) => group.facts.length > 0);
  if (visibleProperties.length === 0 && visibleGroups.length === 0) {
    return null;
  }

  return (
    <div
      className="grid max-w-5xl min-w-0 grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] gap-x-6 gap-y-0.5"
      data-collection-property-panel
    >
      {visibleProperties.map((property) => {
        const column = resolveStandardPropertyColumn(property);
        const edit = property.capabilities?.edit;
        return (
          <PanelRow
            key={`property:${property.key}`}
            icon={PROPERTY_TYPE_ICONS[column?.type ?? "text"]}
            label={property.label}
            rowAttributes={{ "data-collection-panel-property": property.key }}
          >
            {edit && panelRowKind(property, item) === "edit" ? (
              <CollectionPropertyEditor
                column={column}
                edit={edit}
                item={item}
                property={property}
              />
            ) : (
              <CollectionPropertyValue
                context="detail"
                property={property as CollectionPropertyDefinition<unknown>}
                item={item}
              />
            )}
          </PanelRow>
        );
      })}
      {visibleGroups.map((group) => (
        <Fragment key={`group:${group.key}`}>
          {group.label ? (
            <h3
              className="col-span-2 px-1.5 pt-3 pb-1 text-xs font-medium text-muted-foreground"
              data-collection-panel-fact-group={group.key}
            >
              {group.label}
            </h3>
          ) : null}
          {group.facts.map((fact) => (
            <PanelRow
              key={`fact:${group.key}:${fact.key}`}
              icon={fact.icon ?? factValueIcon(fact.value)}
              label={fact.label}
              rowAttributes={{ "data-collection-panel-fact": fact.key }}
            >
              <FactValue value={fact.value} />
            </PanelRow>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * How the panel shows a property of the item: editable where its owner
 * declared editing, as a value otherwise; null when it is not shown.
 */
function panelRowKind<Item>(
  property: CollectionPropertyDefinition<Item>,
  item: Item,
): "edit" | "value" | null {
  const applicability = readCollectionPropertyApplicability(
    property as CollectionPropertyDefinition<unknown>,
    item,
  );
  if (applicability.status === "hidden") return null;
  if (applicability.status === "unavailable") return "value";
  const edit = property.capabilities?.edit;
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
  if (isEmptyPanelValue(property, item)) return null;
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
  icon: Icon,
  label,
  rowAttributes,
}: {
  children: ReactNode;
  icon: LucideIcon;
  label: string;
  rowAttributes: Record<string, string>;
}) {
  return (
    <div className="contents" {...rowAttributes}>
      <div className="flex min-w-0 items-start gap-1.5 px-1.5 py-1.5 text-sm leading-5 text-muted-foreground">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          {label}
        </span>
      </div>
      <div className="flex min-w-0 items-start px-2 py-1.5 text-sm leading-5">
        <div className="min-w-0 flex-1">{children}</div>
      </div>
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

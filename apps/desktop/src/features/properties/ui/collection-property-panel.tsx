import { Fragment, type ReactNode } from "react";
import { Folder, SquareTerminal, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
import { PROPERTY_TYPE_ICONS } from "./property-type-meta";

/**
 * Read-only properties of one item of a fixed Collection, built from the same
 * property definitions as its Table and List columns, followed by the item's
 * facts under their group labels. Empty facts and groups are not shown.
 */
export function CollectionPropertyPanel<Row>({
  factGroups = [],
  properties,
  row,
}: {
  factGroups?: readonly CollectionPropertyFactGroup[];
  properties: readonly CollectionPropertyDefinition<Row>[];
  row: Row;
}) {
  const visibleProperties = properties.filter(
    (property) =>
      readCollectionPropertyApplicability(
        property as CollectionPropertyDefinition<unknown>,
        row,
      ).status !== "hidden",
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
      className="grid min-w-0 grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] gap-x-6 gap-y-0.5"
      data-collection-property-panel
    >
      {visibleProperties.map((property) => {
        const column = resolveStandardPropertyColumn(property);
        return (
          <PanelRow
            key={`property:${property.key}`}
            icon={PROPERTY_TYPE_ICONS[column?.type ?? "text"]}
            label={property.label}
            rowAttributes={{ "data-collection-panel-property": property.key }}
          >
            <CollectionPropertyValue
              context="detail"
              property={property as CollectionPropertyDefinition<unknown>}
              row={row}
            />
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

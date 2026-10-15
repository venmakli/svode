import * as m from "@/paraglide/messages.js";

import {
  resolveStandardPropertyColumn,
  type CollectionPropertyApplicability,
  type CollectionPropertyDefinition,
} from "../model/collection-property";
import { PropertyValue } from "./property-value";

export function CollectionInlineDiagnostic({ message }: { message: string }) {
  return (
    <span
      role="alert"
      className="text-xs text-destructive"
      data-collection-diagnostic
    >
      {message}
    </span>
  );
}

/**
 * The value of a Collection property: the standard display of its semantics
 * or the owner's render. `detail` is the row's detail, where a custom
 * property may show more than in a cell.
 */
export function CollectionPropertyValue({
  property,
  row,
  context = "cell",
}: {
  property: CollectionPropertyDefinition<unknown>;
  row: unknown;
  context?: "cell" | "detail";
}) {
  const applicability = readCollectionPropertyApplicability(property, row);
  if (applicability.status === "hidden") return null;
  if (applicability.status !== "applicable") {
    return (
      <CollectionPropertyPassiveState
        applicability={applicability}
        propertyKey={property.key}
      />
    );
  }

  const value = property.getValue(row);

  const display =
    property.semantics.kind === "custom"
      ? property.semantics
      : property.semantics.display;
  if (display) {
    if (context === "cell") return display.render(value, row);
    const rendered = (display.renderDetail ?? display.render)(value, row);
    // An empty custom value reads like an empty standard one.
    return rendered === null ||
      rendered === undefined ||
      rendered === false ||
      rendered === "" ? (
      <span className="text-muted-foreground">-</span>
    ) : (
      rendered
    );
  }

  const column = resolveStandardPropertyColumn(property);
  if (column) {
    return (
      <PropertyValue
        actors={property.actorCandidates}
        column={column}
        value={value}
      />
    );
  }

  return (
    <CollectionInlineDiagnostic
      message={m.collection_property_renderer_unavailable({
        property: property.key,
      })}
    />
  );
}

export function readCollectionPropertyApplicability(
  property: CollectionPropertyDefinition<unknown>,
  row: unknown,
): CollectionPropertyApplicability {
  try {
    return property.getApplicability?.(row) ?? { status: "applicable" };
  } catch {
    return {
      label: m.collection_callback_error(),
      status: "unavailable",
    };
  }
}

export function CollectionPropertyPassiveState({
  applicability,
  propertyKey,
}: {
  applicability: Exclude<
    CollectionPropertyApplicability,
    { status: "applicable" | "hidden" }
  >;
  propertyKey: string;
}) {
  return (
    <span
      className="text-xs text-muted-foreground"
      data-collection-property={propertyKey}
      data-collection-property-applicability={applicability.status}
    >
      {applicability.label}
    </span>
  );
}

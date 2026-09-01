import type {
  CollectionDeveloperDiagnostic,
  CollectionPresentationInstance,
  CollectionPresentationRuntime,
} from "./types";
import { collectionPresentationRuntimeBrand } from "./types";

const stableIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

interface ErasedCollectionPresentationRuntime extends CollectionPresentationRuntime {
  readonly instance: CollectionPresentationInstance<unknown>;
  readonly diagnostics: readonly CollectionDeveloperDiagnostic[];
}

function diagnostic(
  code: CollectionDeveloperDiagnostic["code"],
  message: string,
): CollectionDeveloperDiagnostic {
  return { code, message };
}

function isStableId(value: string): boolean {
  return stableIdPattern.test(value);
}

function isPromiseLike(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }

  return typeof (value as { then?: unknown }).then === "function";
}

function validateProperty<Row>(
  property: CollectionPresentationInstance<Row>["descriptor"]["properties"][number],
): CollectionDeveloperDiagnostic[] {
  const diagnostics: CollectionDeveloperDiagnostic[] = [];

  if (!isStableId(property.key)) {
    diagnostics.push(
      diagnostic(
        "invalid-property-key",
        `Property key "${property.key}" must be a stable, non-localized id.`,
      ),
    );
  }

  const { capabilities, origin, owner, semantics } = property;
  if (origin === "schema_backed" && owner.kind !== "schema") {
    diagnostics.push(
      diagnostic(
        "invalid-property-owner",
        `Schema-backed property "${property.key}" must be owned by its schema column.`,
      ),
    );
  }
  if (origin === "schema_backed" && semantics.kind !== "standard") {
    diagnostics.push(
      diagnostic(
        "invalid-property-origin",
        `Schema-backed property "${property.key}" must use standard value semantics.`,
      ),
    );
  }
  if (origin !== "schema_backed" && owner.kind !== "feature") {
    diagnostics.push(
      diagnostic(
        "invalid-property-owner",
        `Property "${property.key}" with origin "${origin}" must be owned by its domain feature.`,
      ),
    );
  }
  if (origin === "domain_specific" && semantics.kind !== "custom") {
    diagnostics.push(
      diagnostic(
        "invalid-property-origin",
        `Domain-specific property "${property.key}" must define custom value semantics.`,
      ),
    );
  }
  if (origin === "computed" && capabilities?.edit) {
    diagnostics.push(
      diagnostic(
        "invalid-property-origin",
        `Computed property "${property.key}" cannot declare editing.`,
      ),
    );
  }
  if (
    (capabilities?.filter?.kind === "standard" ||
      capabilities?.sort?.kind === "standard" ||
      capabilities?.edit) &&
    semantics.kind !== "standard"
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-property-capability",
        `Property "${property.key}" declares standard capabilities without standard value semantics.`,
      ),
    );
  }

  return diagnostics;
}

function validateDescriptor<Row>(
  instance: CollectionPresentationInstance<Row>,
): CollectionDeveloperDiagnostic[] {
  const { descriptor } = instance;
  const diagnostics: CollectionDeveloperDiagnostic[] = [];

  if (!isStableId(descriptor.id)) {
    diagnostics.push(
      diagnostic(
        "invalid-presentation-id",
        `Presentation id "${descriptor.id}" must be a stable, non-localized id.`,
      ),
    );
  }

  const propertyKeys = new Set<string>();
  for (const property of descriptor.properties) {
    diagnostics.push(...validateProperty(property));
    if (propertyKeys.has(property.key)) {
      diagnostics.push(
        diagnostic(
          "duplicate-property-key",
          `Presentation "${descriptor.id}" declares property "${property.key}" more than once.`,
        ),
      );
    }
    propertyKeys.add(property.key);
  }

  const layoutKind = (descriptor.layout as { kind?: unknown }).kind;
  if (
    layoutKind !== "table" &&
    layoutKind !== "board" &&
    layoutKind !== "calendar" &&
    layoutKind !== "list" &&
    layoutKind !== "gallery"
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-layout",
        `Presentation "${descriptor.id}" declares an unsupported layout.`,
      ),
    );
  }

  if (layoutKind === "gallery") {
    const galleryLayout = descriptor.layout as Extract<
      typeof descriptor.layout,
      { kind: "gallery" }
    >;
    if (
      !(["small", "medium", "large"] as const).includes(galleryLayout.cardSize)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-gallery-card-size",
          `Presentation "${descriptor.id}" declares an invalid Gallery card size.`,
        ),
      );
    }
    if (
      !(["compact", "comfortable"] as const).includes(galleryLayout.density)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-gallery-density",
          `Presentation "${descriptor.id}" declares an invalid Gallery density.`,
        ),
      );
    }
  }

  if (
    layoutKind === "table" ||
    layoutKind === "board" ||
    layoutKind === "calendar" ||
    layoutKind === "list" ||
    layoutKind === "gallery"
  ) {
    const visibleFieldKeys = new Set<string>();
    for (const propertyKey of descriptor.layout.visibleProperties) {
      if (!propertyKeys.has(propertyKey)) {
        diagnostics.push(
          diagnostic(
            "unknown-visible-property",
            `Presentation "${descriptor.id}" references unknown visible property "${propertyKey}".`,
          ),
        );
      }
      if (visibleFieldKeys.has(propertyKey)) {
        diagnostics.push(
          diagnostic(
            "duplicate-visible-property",
            `Presentation "${descriptor.id}" renders visible property "${propertyKey}" more than once.`,
          ),
        );
      }
      visibleFieldKeys.add(propertyKey);
    }
  }

  const requiredBinding =
    descriptor.layout.kind === "table"
      ? descriptor.layout.primaryProperty
      : descriptor.layout.kind === "board"
        ? descriptor.layout.groupByProperty
        : descriptor.layout.kind === "calendar"
          ? descriptor.layout.dateProperty
          : null;
  if (requiredBinding && !propertyKeys.has(requiredBinding)) {
    diagnostics.push(
      diagnostic(
        "unknown-visible-property",
        `Presentation "${descriptor.id}" references unknown required property "${requiredBinding}".`,
      ),
    );
  }
  if (
    (layoutKind === "board" || layoutKind === "calendar") &&
    !requiredBinding
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-layout",
        `Presentation "${descriptor.id}" is missing its required Property binding.`,
      ),
    );
  }
  if (
    descriptor.layout.kind === "table" &&
    !descriptor.layout.visibleProperties.includes(
      descriptor.layout.primaryProperty,
    )
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-layout",
        `Table presentation "${descriptor.id}" must include its primary property in visibleProperties.`,
      ),
    );
  }

  const actionIds = new Set<string>();
  const actions = [
    ...(descriptor.rowActions ?? []),
    ...(descriptor.create?.intents ?? []),
  ];
  for (const action of actions) {
    if (!isStableId(action.id)) {
      diagnostics.push(
        diagnostic(
          "invalid-action-id",
          `Action id "${action.id}" must be a stable, non-localized id.`,
        ),
      );
    }
    if (actionIds.has(action.id)) {
      diagnostics.push(
        diagnostic(
          "duplicate-action-id",
          `Presentation "${descriptor.id}" declares action "${action.id}" more than once.`,
        ),
      );
    }
    actionIds.add(action.id);
  }

  const { defaultCompare, defaultSort } = descriptor.query;
  if (defaultCompare && defaultSort) {
    diagnostics.push(
      diagnostic(
        "invalid-default-sort",
        `Presentation "${descriptor.id}" cannot declare both defaultSort and defaultCompare.`,
      ),
    );
  }

  const defaultSortFields = new Set<string>();
  for (const sort of defaultSort ?? []) {
    const property = descriptor.properties.find(
      (candidate) => candidate.key === sort.propertyKey,
    );
    if (
      !property?.capabilities?.sort ||
      defaultSortFields.has(sort.propertyKey)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-default-sort",
          `Presentation "${descriptor.id}" has an invalid default sort for property "${sort.propertyKey}".`,
        ),
      );
    }
    defaultSortFields.add(sort.propertyKey);
  }

  return diagnostics;
}

function validateReadyRows<Row>(
  instance: CollectionPresentationInstance<Row>,
): CollectionDeveloperDiagnostic[] {
  if (instance.state.phase !== "ready") {
    return [];
  }

  const rowIds = new Set<string>();
  for (const row of instance.state.rows) {
    let rowId: unknown;
    try {
      rowId = instance.descriptor.getRowId(row);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        diagnostic(
          "row-id-error",
          `Presentation "${instance.descriptor.id}" could not resolve a row id: ${reason}`,
        ),
      ];
    }

    if (
      typeof rowId !== "string" ||
      rowId.length === 0 ||
      rowId.trim() !== rowId
    ) {
      return [
        diagnostic(
          "invalid-row-id",
          `Presentation "${instance.descriptor.id}" returned a non-string, empty, or untrimmed row id.`,
        ),
      ];
    }

    if (rowIds.has(rowId)) {
      return [
        diagnostic(
          "duplicate-row-id",
          `Presentation "${instance.descriptor.id}" returned duplicate row id "${rowId}".`,
        ),
      ];
    }
    rowIds.add(rowId);

    for (const property of instance.descriptor.properties) {
      try {
        const value = property.getValue(row);
        if (isPromiseLike(value)) {
          return [
            diagnostic(
              "async-property-value",
              `Presentation "${instance.descriptor.id}" returned an async value for property "${property.key}". Normalize rows before defining a presentation.`,
            ),
          ];
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return [
          diagnostic(
            "property-value-error",
            `Presentation "${instance.descriptor.id}" could not resolve property "${property.key}": ${reason}`,
          ),
        ];
      }
    }
  }

  return [];
}

function erasePresentation<Row>(
  instance: CollectionPresentationInstance<Row>,
): CollectionPresentationInstance<unknown> {
  return instance as unknown as CollectionPresentationInstance<unknown>;
}

export function defineCollectionPresentation<Row>(
  instance: CollectionPresentationInstance<Row>,
): CollectionPresentationRuntime {
  const diagnostics = [
    ...validateDescriptor(instance),
    ...validateReadyRows(instance),
  ];
  const effectiveInstance =
    diagnostics.length === 0
      ? instance
      : {
          descriptor: instance.descriptor,
          state: {
            phase: "blocking_error" as const,
            error: diagnostics.map(({ message }) => message).join("\n"),
          },
        };

  return Object.freeze({
    [collectionPresentationRuntimeBrand]: true as const,
    diagnostics: Object.freeze(diagnostics),
    instance: erasePresentation(effectiveInstance),
  }) satisfies ErasedCollectionPresentationRuntime;
}

export function readCollectionPresentationRuntime(
  runtime: CollectionPresentationRuntime,
): Readonly<ErasedCollectionPresentationRuntime> {
  return runtime as ErasedCollectionPresentationRuntime;
}

import type {
  SystemCollectionDeveloperDiagnostic,
  SystemCollectionPresentationInstance,
  SystemCollectionPresentationRuntime,
} from "./types";
import { systemCollectionPresentationRuntimeBrand } from "./types";

const stableIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

interface ErasedSystemCollectionPresentationRuntime extends SystemCollectionPresentationRuntime {
  readonly instance: SystemCollectionPresentationInstance<unknown>;
  readonly diagnostics: readonly SystemCollectionDeveloperDiagnostic[];
}

function diagnostic(
  code: SystemCollectionDeveloperDiagnostic["code"],
  message: string,
): SystemCollectionDeveloperDiagnostic {
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

function validateField<Row>(
  field: SystemCollectionPresentationInstance<Row>["descriptor"]["fields"][number],
): SystemCollectionDeveloperDiagnostic[] {
  const diagnostics: SystemCollectionDeveloperDiagnostic[] = [];

  if (!isStableId(field.key)) {
    diagnostics.push(
      diagnostic(
        "invalid-field-key",
        `Field key "${field.key}" must be a stable, non-localized id.`,
      ),
    );
  }

  if (
    field.filter?.kind === "property" &&
    field.valueSemantics?.kind !== "property"
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-property-adapter",
        `Field "${field.key}" uses a property filter without property value semantics.`,
      ),
    );
  }

  if (
    field.sort?.kind === "property" &&
    field.valueSemantics?.kind !== "property"
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-property-adapter",
        `Field "${field.key}" uses property sorting without property value semantics.`,
      ),
    );
  }

  if (field.edit && field.valueSemantics?.kind !== "property") {
    diagnostics.push(
      diagnostic(
        "invalid-property-adapter",
        `Field "${field.key}" declares standard editing without property value semantics.`,
      ),
    );
  }

  return diagnostics;
}

function validateDescriptor<Row>(
  instance: SystemCollectionPresentationInstance<Row>,
): SystemCollectionDeveloperDiagnostic[] {
  const { descriptor } = instance;
  const diagnostics: SystemCollectionDeveloperDiagnostic[] = [];

  if (!isStableId(descriptor.id)) {
    diagnostics.push(
      diagnostic(
        "invalid-presentation-id",
        `Presentation id "${descriptor.id}" must be a stable, non-localized id.`,
      ),
    );
  }

  const fieldKeys = new Set<string>();
  for (const field of descriptor.fields) {
    diagnostics.push(...validateField(field));
    if (fieldKeys.has(field.key)) {
      diagnostics.push(
        diagnostic(
          "duplicate-field-key",
          `Presentation "${descriptor.id}" declares field "${field.key}" more than once.`,
        ),
      );
    }
    fieldKeys.add(field.key);
  }

  const layoutKind = (descriptor.layout as { kind?: unknown }).kind;
  if (layoutKind !== "list" && layoutKind !== "gallery") {
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

  if (layoutKind === "list" || layoutKind === "gallery") {
    const visibleFieldKeys = new Set<string>();
    for (const fieldKey of descriptor.layout.visibleFields) {
      if (!fieldKeys.has(fieldKey)) {
        diagnostics.push(
          diagnostic(
            "unknown-visible-field",
            `Presentation "${descriptor.id}" references unknown visible field "${fieldKey}".`,
          ),
        );
      }
      if (visibleFieldKeys.has(fieldKey)) {
        diagnostics.push(
          diagnostic(
            "duplicate-visible-field",
            `Presentation "${descriptor.id}" renders visible field "${fieldKey}" more than once.`,
          ),
        );
      }
      visibleFieldKeys.add(fieldKey);
    }
  }

  const actionIds = new Set<string>();
  const actions = [
    ...(descriptor.rowActions ?? []),
    ...(descriptor.create ? [descriptor.create] : []),
    ...(descriptor.refresh ? [descriptor.refresh] : []),
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
    const field = descriptor.fields.find(
      (candidate) => candidate.key === sort.fieldKey,
    );
    if (!field?.sort || defaultSortFields.has(sort.fieldKey)) {
      diagnostics.push(
        diagnostic(
          "invalid-default-sort",
          `Presentation "${descriptor.id}" has an invalid default sort for field "${sort.fieldKey}".`,
        ),
      );
    }
    defaultSortFields.add(sort.fieldKey);
  }

  return diagnostics;
}

function validateReadyRows<Row>(
  instance: SystemCollectionPresentationInstance<Row>,
): SystemCollectionDeveloperDiagnostic[] {
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

    for (const field of instance.descriptor.fields) {
      try {
        const value = field.getValue(row);
        if (isPromiseLike(value)) {
          return [
            diagnostic(
              "async-field-value",
              `Presentation "${instance.descriptor.id}" returned an async value for field "${field.key}". Normalize rows before defining a presentation.`,
            ),
          ];
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return [
          diagnostic(
            "field-value-error",
            `Presentation "${instance.descriptor.id}" could not resolve field "${field.key}": ${reason}`,
          ),
        ];
      }
    }
  }

  return [];
}

function erasePresentation<Row>(
  instance: SystemCollectionPresentationInstance<Row>,
): SystemCollectionPresentationInstance<unknown> {
  return instance as unknown as SystemCollectionPresentationInstance<unknown>;
}

export function defineSystemCollectionPresentation<Row>(
  instance: SystemCollectionPresentationInstance<Row>,
): SystemCollectionPresentationRuntime {
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
    [systemCollectionPresentationRuntimeBrand]: true as const,
    diagnostics: Object.freeze(diagnostics),
    instance: erasePresentation(effectiveInstance),
  }) satisfies ErasedSystemCollectionPresentationRuntime;
}

export function readSystemCollectionPresentationRuntime(
  runtime: SystemCollectionPresentationRuntime,
): Readonly<ErasedSystemCollectionPresentationRuntime> {
  return runtime as ErasedSystemCollectionPresentationRuntime;
}

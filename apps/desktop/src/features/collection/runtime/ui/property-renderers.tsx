import { useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

import {
  resolveStandardPropertyColumn,
  validatePropertyValue,
} from "@/features/properties";
import type {
  CollectionPropertyActionState,
  CollectionPropertyApplicability,
  CollectionPropertyDefinition,
} from "@/features/properties";
import { PropertyControl } from "@/features/properties/control";
import { PropertyValue } from "@/features/properties/display";
import * as m from "@/paraglide/messages.js";

import { runCollectionCallback } from "../lib/interaction";

interface CollectionPropertyProps {
  property: CollectionPropertyDefinition<unknown>;
  row: unknown;
}

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

export function CollectionPropertyValue({
  property,
  row,
}: CollectionPropertyProps) {
  const applicability = readPropertyApplicability(property, row);
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

  const column = resolveStandardPropertyColumn(property);
  if (column) {
    return <PropertyValue column={column} value={value} />;
  }

  if (property.semantics.kind === "custom") {
    return property.semantics.render(value, row);
  }

  return (
    <CollectionInlineDiagnostic
      message={m.collection_property_renderer_unavailable({
        property: property.key,
      })}
    />
  );
}

function readPropertyApplicability(
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

function CollectionPropertyPassiveState({
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

function readPropertyState(
  property: CollectionPropertyDefinition<unknown>,
  row: unknown,
): CollectionPropertyActionState {
  try {
    return property.capabilities?.edit?.getState(row) ?? { status: "idle" };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : m.collection_callback_error(),
    };
  }
}

export function CollectionPropertyControl({
  property,
  row,
  density = "default",
  onRejected,
}: CollectionPropertyProps & {
  density?: "default" | "compact";
  onRejected(propertyKey: string, message: string): void;
}) {
  const localPendingRef = useRef(false);
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const applicability = readPropertyApplicability(property, row);
  if (applicability.status === "hidden") return null;
  if (applicability.status !== "applicable") {
    return (
      <CollectionPropertyPassiveState
        applicability={applicability}
        propertyKey={property.key}
      />
    );
  }

  const column = resolveStandardPropertyColumn(property);
  const edit = property.capabilities?.edit;
  if (!column || !edit) {
    return (
      <CollectionInlineDiagnostic
        message={m.collection_property_control_unavailable({
          property: property.key,
        })}
      />
    );
  }

  const value = property.getValue(row);
  const ownerState = readPropertyState(property, row);
  const pending = localPending || ownerState.status === "pending";
  const disabled = pending || ownerState.status === "disabled";
  const message =
    localError ??
    (ownerState.status === "disabled"
      ? ownerState.reason
      : ownerState.status === "error"
        ? ownerState.message
        : undefined);
  const status = localError ? "error" : pending ? "pending" : ownerState.status;
  const validation = validatePropertyValue(column, value);

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-collection-interactive
      data-collection-property={property.key}
      data-collection-property-state={status}
      title={message}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <PropertyControl
          column={column}
          value={value}
          invalid={validation.invalid}
          disabled={disabled}
          accessibilityLabel={
            property.getAccessibilityLabel?.(row) ?? property.label
          }
          density={density}
          onChange={async (nextValue: unknown) => {
            if (localPendingRef.current) return;
            localPendingRef.current = true;
            setLocalPending(true);
            setLocalError(null);
            const result = await runCollectionCallback(
              () => edit.update(row, nextValue),
              m.collection_callback_error(),
            );
            localPendingRef.current = false;
            setLocalPending(false);
            if (!result.ok && result.message) {
              setLocalError(result.message);
              onRejected(property.key, result.message);
            }
          }}
        />
        {pending ? (
          <LoaderCircle
            className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
      </div>
      {message &&
      (ownerState.status !== "disabled" ||
        edit.showDisabledReason !== false) ? (
        <span
          role={status === "error" ? "alert" : undefined}
          className="max-w-64 truncate text-xs text-muted-foreground"
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}

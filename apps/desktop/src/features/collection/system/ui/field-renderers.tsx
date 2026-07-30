import { useState } from "react";
import { LoaderCircle } from "lucide-react";

import { validatePropertyValue } from "@/features/properties";
import { PropertyControl } from "@/features/properties/control";
import { PropertyValue } from "@/features/properties/display";
import * as m from "@/paraglide/messages.js";

import { runSystemCollectionCallback } from "../lib/interaction";
import type {
  SystemCollectionActionState,
  SystemCollectionFieldDescriptor,
} from "../model/types";

interface SystemCollectionFieldProps {
  field: SystemCollectionFieldDescriptor<unknown>;
  row: unknown;
}

export function SystemCollectionInlineDiagnostic({
  message,
}: {
  message: string;
}) {
  return (
    <span
      role="alert"
      className="text-xs text-destructive"
      data-system-collection-diagnostic
    >
      {message}
    </span>
  );
}

export function SystemCollectionFieldValue({
  field,
  row,
}: SystemCollectionFieldProps) {
  const value = field.getValue(row);

  if (field.valueSemantics?.kind === "property") {
    return <PropertyValue column={field.valueSemantics.column} value={value} />;
  }

  if (field.valueSemantics?.kind === "custom") {
    return field.valueSemantics.render(value, row);
  }

  return (
    <SystemCollectionInlineDiagnostic
      message={m.system_collection_field_renderer_unavailable({
        field: field.key,
      })}
    />
  );
}

function readFieldState(
  field: SystemCollectionFieldDescriptor<unknown>,
  row: unknown,
): SystemCollectionActionState {
  try {
    return field.edit?.getState(row) ?? { status: "idle" };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error && error.message
          ? error.message
          : m.system_collection_callback_error(),
    };
  }
}

export function SystemCollectionFieldControl({
  field,
  row,
  onRejected,
}: SystemCollectionFieldProps & {
  onRejected(fieldKey: string, message: string): void;
}) {
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (field.valueSemantics?.kind !== "property" || !field.edit) {
    return (
      <SystemCollectionInlineDiagnostic
        message={m.system_collection_field_control_unavailable({
          field: field.key,
        })}
      />
    );
  }

  const edit = field.edit;
  const { column } = field.valueSemantics;
  const value = field.getValue(row);
  const ownerState = readFieldState(field, row);
  const pending = localPending || ownerState.status === "pending";
  const disabled = pending || ownerState.status === "disabled";
  const message =
    localError ??
    (ownerState.status === "disabled"
      ? ownerState.reason
      : ownerState.status === "error"
        ? ownerState.message
        : undefined);
  const status = localError ? "error" : ownerState.status;
  const validation = validatePropertyValue(column, value);

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-system-collection-interactive
      data-system-collection-field={field.key}
      data-system-collection-field-state={status}
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
          onChange={async (nextValue: unknown) => {
            setLocalPending(true);
            setLocalError(null);
            const result = await runSystemCollectionCallback(
              () => edit.update(row, nextValue),
              m.system_collection_callback_error(),
            );
            setLocalPending(false);
            if (!result.ok && result.message) {
              setLocalError(result.message);
              onRejected(field.key, result.message);
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
      {message ? (
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

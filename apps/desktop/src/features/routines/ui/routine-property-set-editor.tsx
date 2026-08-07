import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import * as m from "@/paraglide/messages.js";

import {
  parseRoutineValueInput,
  routineValueInput,
} from "../model/routine-draft";

export function RoutinePropertySetEditor({
  invalid,
  value,
  onChange,
}: {
  invalid: boolean;
  value: Readonly<Record<string, unknown>>;
  onChange(value: Readonly<Record<string, unknown>>): void;
}) {
  const entries = Object.entries(value);
  return (
    <Field data-invalid={invalid}>
      <FieldLabel>{m.routines_properties_set_label()}</FieldLabel>
      <FieldGroup className="gap-3">
        {entries.map(([property, propertyValue], index) => (
          <div key={index} className="flex items-start gap-2">
            <Input
              aria-label={m.routines_property_key_label()}
              value={property}
              onChange={(event) => {
                const nextKey = event.target.value;
                const next = { ...value };
                delete next[property];
                next[nextKey] = propertyValue;
                onChange(next);
              }}
            />
            <Input
              aria-label={m.routines_property_value_label()}
              value={routineValueInput(propertyValue)}
              onChange={(event) =>
                onChange({
                  ...value,
                  [property]: parseRoutineValueInput(event.target.value),
                })
              }
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.routines_property_remove()}
              onClick={() => {
                const next = { ...value };
                delete next[property];
                onChange(next);
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </FieldGroup>
      {invalid ? (
        <FieldError>{m.routines_properties_set_required()}</FieldError>
      ) : (
        <FieldDescription>{m.routines_properties_set_hint()}</FieldDescription>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => {
          let suffix = entries.length + 1;
          let key = entries.length === 0 ? "property" : `property_${suffix}`;
          while (Object.hasOwn(value, key)) {
            suffix += 1;
            key = `property_${suffix}`;
          }
          onChange({ ...value, [key]: null });
        }}
      >
        <Plus data-icon="inline-start" />
        {m.routines_property_add()}
      </Button>
    </Field>
  );
}

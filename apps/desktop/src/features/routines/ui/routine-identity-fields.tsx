import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import * as m from "@/paraglide/messages.js";

import type { RoutineDefinition } from "../model/types";

export function RoutineIdentityFields({
  autoFocus = false,
  definition,
  idPrefix,
  nameError = null,
  showValidation = true,
  onChange,
}: {
  autoFocus?: boolean;
  definition: RoutineDefinition;
  idPrefix: string;
  nameError?: string | null;
  showValidation?: boolean;
  onChange(definition: RoutineDefinition): void;
}) {
  const nameShapeInvalid =
    showValidation &&
    (!definition.name.trim() || definition.name.trim().length > 240);
  const nameInvalid = nameShapeInvalid || Boolean(nameError);
  const descriptionInvalid =
    showValidation && definition.description.length > 2_000;
  return (
    <FieldGroup>
      <Field data-invalid={nameInvalid}>
        <FieldLabel htmlFor={`${idPrefix}-name`}>
          {m.routines_title_label()}
        </FieldLabel>
        <Input
          id={`${idPrefix}-name`}
          autoFocus={autoFocus}
          data-routine-create-focus="basics"
          aria-invalid={nameInvalid}
          maxLength={240}
          value={definition.name}
          onChange={(event) =>
            onChange({ ...definition, name: event.target.value })
          }
        />
        {nameInvalid ? (
          <FieldError>{nameError ?? m.routines_title_required()}</FieldError>
        ) : null}
      </Field>
      <Field data-invalid={descriptionInvalid}>
        <FieldLabel htmlFor={`${idPrefix}-description`}>
          {m.routines_description_label()}
        </FieldLabel>
        <Textarea
          id={`${idPrefix}-description`}
          aria-invalid={descriptionInvalid}
          maxLength={2_000}
          value={definition.description}
          onChange={(event) =>
            onChange({ ...definition, description: event.target.value })
          }
        />
        {descriptionInvalid ? (
          <FieldError>{m.routines_description_too_long()}</FieldError>
        ) : (
          <FieldDescription>{m.routines_description_hint()}</FieldDescription>
        )}
      </Field>
    </FieldGroup>
  );
}

import { useState } from "react";

import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isValidEmail, isValidName } from "@/features/identity";
import * as m from "@/paraglide/messages.js";

export interface ActorIdentityDraft {
  displayName: string;
  canonicalEmail: string;
}

export function ActorIdentityFields({
  initialValue,
  pending,
  onSubmit,
}: {
  initialValue: ActorIdentityDraft;
  pending: boolean;
  onSubmit(value: ActorIdentityDraft): void;
}) {
  const [value, setValue] = useState(initialValue);
  const [touched, setTouched] = useState({ email: false, name: false });
  const nameValid = actorDisplayNameIsValid(value.displayName);
  const emailValid = isValidEmail(value.canonicalEmail.trim());

  return (
    <form
      id="actor-mutation-form"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const submitted = identityDraftFromForm(event.currentTarget);
        const submittedNameValid = actorDisplayNameIsValid(
          submitted.displayName,
        );
        const submittedEmailValid = isValidEmail(
          submitted.canonicalEmail.trim(),
        );
        setValue(submitted);
        setTouched({ email: true, name: true });
        if (!submittedNameValid || !submittedEmailValid || pending) return;
        onSubmit({
          canonicalEmail: submitted.canonicalEmail.trim(),
          displayName: submitted.displayName.trim(),
        });
      }}
    >
      <FieldGroup>
        <Field data-invalid={touched.name && !nameValid ? true : undefined}>
          <FieldLabel htmlFor="actor-mutation-name">
            {m.actors_mutation_name_label()}
          </FieldLabel>
          <Input
            id="actor-mutation-name"
            name="displayName"
            autoFocus
            disabled={pending}
            value={value.displayName}
            aria-invalid={touched.name && !nameValid}
            onBlur={() => setTouched((current) => ({ ...current, name: true }))}
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                displayName: event.target.value,
              }))
            }
          />
          {touched.name && !nameValid ? (
            <FieldError>{m.actors_mutation_name_invalid()}</FieldError>
          ) : null}
        </Field>

        <Field data-invalid={touched.email && !emailValid ? true : undefined}>
          <FieldLabel htmlFor="actor-mutation-email">
            {m.actors_mutation_email_label()}
          </FieldLabel>
          <Input
            id="actor-mutation-email"
            name="canonicalEmail"
            type="email"
            disabled={pending}
            value={value.canonicalEmail}
            aria-invalid={touched.email && !emailValid}
            onBlur={() =>
              setTouched((current) => ({ ...current, email: true }))
            }
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                canonicalEmail: event.target.value,
              }))
            }
          />
          {touched.email && !emailValid ? (
            <FieldError>{m.actors_mutation_email_invalid()}</FieldError>
          ) : null}
        </Field>
      </FieldGroup>
    </form>
  );
}

function actorDisplayNameIsValid(value: string) {
  return isValidName(value) && !/[\r\n<>#]/.test(value);
}

function identityDraftFromForm(form: HTMLFormElement): ActorIdentityDraft {
  const formData = new FormData(form);
  return {
    canonicalEmail: String(formData.get("canonicalEmail") ?? ""),
    displayName: String(formData.get("displayName") ?? ""),
  };
}

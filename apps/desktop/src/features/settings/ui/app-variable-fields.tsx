import { useId } from "react";
import * as m from "@/paraglide/messages.js";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  validVariableName,
  type VariableDraft,
} from "../model/app-variable-draft";

export function AppVariableFields({
  draft,
  disabled,
  onChange,
  compact = false,
  fixedKind,
}: {
  draft: VariableDraft;
  disabled: boolean;
  onChange(draft: VariableDraft): void;
  compact?: boolean;
  fixedKind?: "secret";
}) {
  const id = useId();
  const invalid = draft.name.length > 0 && !validVariableName(draft.name);
  return (
    <FieldGroup className={compact ? "gap-3" : undefined}>
      {!compact || !draft.editing ? (
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor={`${id}-name`}>
            {m.settings_variables_name()}
          </FieldLabel>
          <Input
            id={`${id}-name`}
            value={draft.name}
            disabled={disabled || draft.editing}
            aria-invalid={invalid}
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value.toUpperCase() })
            }
          />
          {!compact || invalid ? (
            <FieldDescription>
              {m.settings_variables_name_hint()}
            </FieldDescription>
          ) : null}
        </Field>
      ) : null}
      {!fixedKind && (
        <Field orientation={compact ? "horizontal" : "vertical"}>
          <FieldLabel id={`${id}-kind`}>
            {m.settings_variables_kind()}
          </FieldLabel>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={draft.kind}
            disabled={disabled}
            aria-labelledby={`${id}-kind`}
            onValueChange={(kind) => {
              if (kind === "variable" || kind === "secret")
                onChange({ ...draft, kind });
            }}
          >
            <ToggleGroupItem value="variable">
              {m.settings_variables_kind_variable()}
            </ToggleGroupItem>
            <ToggleGroupItem value="secret">
              {m.settings_variables_kind_secret()}
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={`${id}-value`}>
          {m.settings_variables_value()}
        </FieldLabel>
        <Input
          id={`${id}-value`}
          autoFocus={compact}
          type={draft.kind === "secret" ? "password" : "text"}
          value={draft.value}
          disabled={disabled}
          autoComplete="off"
          placeholder={
            !compact && draft.kind === "secret" && draft.preservesSecret
              ? m.settings_variables_secret_unchanged()
              : undefined
          }
          onChange={(event) =>
            onChange({ ...draft, value: event.target.value })
          }
        />
        {compact ? (
          draft.kind === "secret" && draft.preservesSecret ? (
            <FieldDescription>{m.app_variables_keep_secret()}</FieldDescription>
          ) : null
        ) : (
          <FieldDescription>
            {draft.kind === "secret"
              ? m.settings_variables_secret_hint()
              : m.settings_variables_value_hint()}
          </FieldDescription>
        )}
      </Field>
    </FieldGroup>
  );
}

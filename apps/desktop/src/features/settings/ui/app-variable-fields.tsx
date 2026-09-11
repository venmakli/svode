import { useId } from "react";
import * as m from "@/paraglide/messages.js";
import { cn } from "@/shared/lib/utils";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import type { AppVariableEntry } from "../model/app-variables";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  validVariableName,
  editVariableDraft,
  type VariableDraft,
} from "../model/app-variable-draft";

export function AppVariableFields({
  draft,
  disabled,
  onChange,
  compact = false,
  showOwner = true,
  fixedKind,
  collisionAlternatives,
}: {
  draft: VariableDraft;
  disabled: boolean;
  onChange(draft: VariableDraft): void;
  compact?: boolean;
  showOwner?: boolean;
  fixedKind?: "secret";
  collisionAlternatives?: AppVariableEntry[];
}) {
  const id = useId();
  const invalid = draft.name.length > 0 && !validVariableName(draft.name);
  return (
    <FieldGroup className={cn("gap-4", compact && "gap-3")}>
      {showOwner ? (
        <p className="text-xs text-muted-foreground wrap-anywhere">
          {draft.owner.scope === "library"
            ? m.variables_library()
            : draft.ownerLabel}
        </p>
      ) : null}
      {!draft.editing ? (
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor={`${id}-name`}>
            {m.settings_variables_name()}
          </FieldLabel>
          <Input
            id={`${id}-name`}
            value={draft.name}
            autoFocus={!compact}
            placeholder="API_TOKEN"
            aria-describedby={invalid ? `${id}-name-hint` : undefined}
            disabled={disabled || draft.editing}
            aria-invalid={invalid}
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value.toUpperCase() })
            }
          />
          {invalid ? (
            <FieldDescription id={`${id}-name-hint`}>
              {m.settings_variables_name_hint()}
            </FieldDescription>
          ) : null}
        </Field>
      ) : null}
      {draft.keep && collisionAlternatives ? (
        <Field>
          <FieldLabel id={`${id}-conflict`}>
            {m.variables_conflict()}
          </FieldLabel>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={draft.keep}
            disabled={disabled}
            aria-labelledby={`${id}-conflict`}
            onValueChange={(mode) => {
              const selected = collisionAlternatives.find(
                (entry) => entry.mode === mode,
              );
              if (selected) onChange(editVariableDraft(selected));
            }}
          >
            <ToggleGroupItem value="local">
              {m.variables_local()}
            </ToggleGroupItem>
            <ToggleGroupItem value="git">Git</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      ) : null}
      <FieldGroup className="flex-row flex-wrap items-center gap-4">
        <Field orientation="horizontal" className="w-auto gap-3">
          <FieldLabel id={`${id}-storage`}>{m.variables_storage()}</FieldLabel>
          {draft.owner.scope === "library" ? (
            <span className="text-sm">{m.variables_local()}</span>
          ) : (
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={draft.storage}
              disabled={disabled}
              aria-labelledby={`${id}-storage`}
              onValueChange={(storage) => {
                if (storage === "local" || storage === "git")
                  onChange({ ...draft, storage });
              }}
            >
              <ToggleGroupItem value="local">
                {m.variables_local()}
              </ToggleGroupItem>
              <ToggleGroupItem value="git">Git</ToggleGroupItem>
            </ToggleGroup>
          )}
        </Field>
        <Field orientation="horizontal" className="w-auto gap-3">
          <FieldLabel htmlFor={`${id}-secret`}>
            {m.variables_secret()}
          </FieldLabel>
          <Switch
            id={`${id}-secret`}
            checked={draft.kind === "secret"}
            disabled={disabled || Boolean(fixedKind)}
            onCheckedChange={(secret) =>
              onChange({
                ...draft,
                kind: secret ? "secret" : "variable",
                value:
                  !secret && draft.originalKind === "secret" ? "" : draft.value,
                explicitOrdinary: secret
                  ? draft.explicitOrdinary
                  : draft.originalKind !== "secret",
              })
            }
          />
        </Field>
      </FieldGroup>
      {draft.keep ? (
        <p role="status" className="text-sm">
          {m.variables_collision_keep({
            keep: draft.keep === "git" ? "Git" : m.variables_local(),
            remove: draft.keep === "git" ? m.variables_local() : "Git",
          })}
        </p>
      ) : null}
      {draft.editing &&
      draft.originalStorage === "git" &&
      draft.storage === "local" ? (
        <p className="text-xs text-muted-foreground">
          {m.variables_git_to_local()}
        </p>
      ) : null}
      {draft.editing &&
      draft.originalStorage === "git" &&
      draft.originalKind === "variable" &&
      (draft.storage === "local" || draft.kind === "secret") ? (
        <p className="text-xs text-muted-foreground">
          {m.variables_git_history()}
        </p>
      ) : null}
      {draft.editing &&
      draft.originalKind === "secret" &&
      draft.kind === "variable" ? (
        <p className="text-xs text-muted-foreground">
          {m.variables_explicit_value()}
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${id}-value`}>
          {m.settings_variables_value()}
        </FieldLabel>
        <Input
          id={`${id}-value`}
          autoFocus={compact || draft.editing}
          aria-describedby={`${id}-value-hint`}
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
            onChange({
              ...draft,
              value: event.target.value,
              explicitOrdinary:
                draft.kind === "variable" || draft.explicitOrdinary,
            })
          }
        />
        <FieldDescription id={`${id}-value-hint`}>
          {draft.storage === "git"
            ? draft.kind === "secret"
              ? m.variables_git_secret_hint()
              : m.variables_git_hint()
            : draft.kind === "secret"
              ? m.settings_variables_secret_hint()
              : draft.owner.scope === "library"
                ? m.settings_variables_value_hint()
                : m.variables_scoped_local_hint()}
        </FieldDescription>
        {draft.kind === "secret" && draft.preservesSecret ? (
          <FieldDescription>{m.app_variables_keep_secret()}</FieldDescription>
        ) : null}
        {draft.kind === "secret" &&
        draft.storage === "git" &&
        (!draft.editing || draft.originalKind === "secret") &&
        !draft.preservesSecret &&
        !draft.value ? (
          <FieldDescription>{m.variables_unset_here()}</FieldDescription>
        ) : null}
        {draft.kind === "variable" && !draft.explicitOrdinary ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChange({ ...draft, value: "", explicitOrdinary: true })
            }
          >
            {m.variables_empty_value()}
          </Button>
        ) : null}
      </Field>
    </FieldGroup>
  );
}

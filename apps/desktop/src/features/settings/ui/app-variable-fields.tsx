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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  const secretControl = (
    <Field className="w-auto" data-disabled={disabled || Boolean(fixedKind)}>
      <FieldLabel htmlFor={`${id}-secret`}>{m.variables_secret()}</FieldLabel>
      <div className="flex h-8 items-center">
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
      </div>
    </Field>
  );
  const valueFields = (
    <>
      {!compact || !draft.editing ? (
        <Field
          className={cn(
            "col-span-2 min-w-0",
            !compact && "@min-[40rem]/variable-form:col-span-1",
          )}
          data-invalid={invalid}
          data-disabled={disabled || draft.editing}
        >
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
      <Field
        className={cn(
          "col-span-2 min-w-0",
          !compact && "@min-[40rem]/variable-form:col-span-1",
        )}
        data-disabled={disabled}
      >
        <FieldLabel htmlFor={`${id}-value`}>
          {m.settings_variables_value()}
        </FieldLabel>
        <Input
          id={`${id}-value`}
          autoFocus={compact || draft.editing}
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
        {draft.kind === "secret" && draft.preservesSecret ? (
          <FieldDescription>{m.app_variables_keep_secret()}</FieldDescription>
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
    </>
  );
  const fields = (
    <FieldGroup className="gap-4">
      <FieldGroup
        className={cn(
          "grid grid-cols-2 items-start gap-4",
          !compact &&
            "@min-[40rem]/variable-form:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]",
        )}
      >
        {draft.owner.scope === "global" ? (
          valueFields
        ) : (
          <TabsContent value={draft.storage} className="contents">
            {valueFields}
          </TabsContent>
        )}
        <Field className="w-auto" data-disabled={disabled}>
          <FieldLabel id={`${id}-storage`}>{m.variables_storage()}</FieldLabel>
          {draft.owner.scope === "global" ? (
            <span className="flex h-8 items-center text-sm text-muted-foreground">
              {m.variables_local()}
            </span>
          ) : (
            <TabsList
              aria-label={m.variables_storage()}
              aria-labelledby={`${id}-storage`}
            >
              <TabsTrigger value="local" disabled={disabled}>
                {m.variables_local()}
              </TabsTrigger>
              <TabsTrigger value="git" disabled={disabled}>
                Git
              </TabsTrigger>
            </TabsList>
          )}
        </Field>
        {secretControl}
      </FieldGroup>
      {draft.editing && draft.owner.scope === "global" ? (
        <FieldDescription>{m.variables_global_edit_hint()}</FieldDescription>
      ) : null}
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
    </FieldGroup>
  );
  return (
    <FieldGroup
      className={cn("@container/variable-form gap-4", compact && "gap-3")}
    >
      {showOwner ? (
        <p className="text-xs text-muted-foreground wrap-anywhere">
          {draft.owner.scope === "global"
            ? m.variables_global()
            : draft.ownerLabel}
        </p>
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
      {draft.owner.scope === "global" ? (
        fields
      ) : (
        <Tabs
          className="min-w-0 gap-4"
          value={draft.storage}
          onValueChange={(storage) => {
            if (!disabled && (storage === "local" || storage === "git"))
              onChange({ ...draft, storage });
          }}
        >
          {fields}
        </Tabs>
      )}
    </FieldGroup>
  );
}

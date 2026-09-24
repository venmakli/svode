import { useId, type ReactNode } from "react";
import * as m from "@/paraglide/messages.js";
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
import { SettingsRow, SettingsRows } from "./settings-layout";

interface AppVariableFieldsProps {
  // rows: Settings catalog and S3 Secret editors; compact: App modal.
  layout: "rows" | "compact";
  draft: VariableDraft;
  disabled: boolean;
  onChange(draft: VariableDraft): void;
  showOwner?: boolean;
  fixedKind?: "secret";
  collisionAlternatives?: AppVariableEntry[];
  nameError?: string | null;
  usage?: ReactNode;
  currentValue?: string | null;
}

export function AppVariableFields(props: AppVariableFieldsProps) {
  return props.layout === "rows" ? (
    <VariableFieldRows {...props} />
  ) : (
    <VariableFieldCompact {...props} />
  );
}

function withSecret(draft: VariableDraft, secret: boolean): VariableDraft {
  return {
    ...draft,
    kind: secret ? "secret" : "variable",
    value: !secret && draft.originalKind === "secret" ? "" : draft.value,
    explicitOrdinary: secret
      ? draft.explicitOrdinary
      : draft.originalKind !== "secret",
  };
}

function withValue(draft: VariableDraft, value: string): VariableDraft {
  return {
    ...draft,
    value,
    explicitOrdinary: draft.kind === "variable" || draft.explicitOrdinary,
  };
}

function transitions(draft: VariableDraft) {
  return {
    gitToLocal:
      draft.editing &&
      draft.originalStorage === "git" &&
      draft.storage === "local",
    gitHistory:
      draft.editing &&
      draft.originalStorage === "git" &&
      draft.originalKind === "variable" &&
      (draft.storage === "local" || draft.kind === "secret"),
    explicitValue:
      draft.editing &&
      draft.originalKind === "secret" &&
      draft.kind === "variable",
  };
}

function CollisionChoice({
  draft,
  disabled,
  onChange,
  alternatives,
  labelledBy,
}: {
  draft: VariableDraft;
  disabled: boolean;
  onChange(draft: VariableDraft): void;
  alternatives: AppVariableEntry[];
  labelledBy?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={draft.keep}
      disabled={disabled}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : m.variables_conflict()}
      onValueChange={(mode) => {
        const selected = alternatives.find((entry) => entry.mode === mode);
        if (selected) onChange(editVariableDraft(selected));
      }}
    >
      <ToggleGroupItem value="local">{m.variables_local()}</ToggleGroupItem>
      <ToggleGroupItem value="git">Git</ToggleGroupItem>
    </ToggleGroup>
  );
}

function lines(...items: Array<string | false | null | undefined>) {
  const visible = items.filter(Boolean);
  return visible.length
    ? visible.map((item) => (
        <span key={item as string} className="block">
          {item}
        </span>
      ))
    : null;
}

// One Settings editor row expands into field rows: each control sits right
// of its label and the consequence of a change is the description of the
// changed row.
function VariableFieldRows({
  draft,
  disabled,
  onChange,
  fixedKind,
  collisionAlternatives,
  nameError,
  usage,
  currentValue,
}: AppVariableFieldsProps) {
  const id = useId();
  const scoped = draft.owner.scope !== "global";
  const invalid = draft.name.length > 0 && !validVariableName(draft.name);
  const nameProblem = invalid ? m.settings_variables_name_hint() : nameError;
  const change = transitions(draft);
  const valueRow = (
    <SettingsRow
      label={m.settings_variables_value()}
      htmlFor={`${id}-value`}
      description={lines(
        currentValue != null &&
          m.variables_current_value({ value: currentValue }),
        draft.kind === "secret" &&
          draft.preservesSecret &&
          m.app_variables_keep_secret(),
        draft.editing &&
          draft.owner.scope === "global" &&
          m.variables_global_edit_hint(),
      )}
      data-disabled={disabled}
    >
      <Input
        id={`${id}-value`}
        className="w-72 max-w-full"
        autoFocus={draft.editing}
        type={draft.kind === "secret" ? "password" : "text"}
        value={draft.value}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => onChange(withValue(draft, event.target.value))}
      />
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
    </SettingsRow>
  );
  const rows = (
    <SettingsRows>
      {draft.keep && collisionAlternatives ? (
        <SettingsRow
          key="conflict"
          label={m.variables_conflict()}
          description={
            <span role="status">
              {m.variables_collision_keep({
                keep: draft.keep === "git" ? "Git" : m.variables_local(),
                remove: draft.keep === "git" ? m.variables_local() : "Git",
              })}
            </span>
          }
        >
          <CollisionChoice
            draft={draft}
            disabled={disabled}
            onChange={onChange}
            alternatives={collisionAlternatives}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow
        key="name"
        label={m.settings_variables_name()}
        htmlFor={`${id}-name`}
        description={usage}
        error={nameProblem}
        errorId={`${id}-name-hint`}
        data-disabled={disabled}
      >
        <Input
          id={`${id}-name`}
          className="w-72 max-w-full font-mono"
          value={draft.name}
          autoFocus={!draft.editing}
          placeholder="API_TOKEN"
          aria-describedby={nameProblem ? `${id}-name-hint` : undefined}
          disabled={disabled || draft.editing}
          aria-invalid={Boolean(nameProblem)}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) =>
            onChange({ ...draft, name: event.target.value.toUpperCase() })
          }
        />
      </SettingsRow>
      {scoped ? (
        <TabsContent key="value" value={draft.storage} className="contents">
          {valueRow}
        </TabsContent>
      ) : (
        valueRow
      )}
      {scoped ? (
        <SettingsRow
          key="storage"
          label={m.variables_storage()}
          description={
            change.gitToLocal
              ? lines(
                  m.variables_git_to_local(),
                  change.gitHistory && m.variables_git_history(),
                )
              : draft.storage === "local"
                ? m.variables_scoped_local_hint()
                : draft.kind === "secret"
                  ? m.variables_git_secret_hint()
                  : m.variables_git_hint()
          }
          data-disabled={disabled}
        >
          <TabsList aria-label={m.variables_storage()}>
            <TabsTrigger value="local" disabled={disabled}>
              {m.variables_local()}
            </TabsTrigger>
            <TabsTrigger value="git" disabled={disabled}>
              Git
            </TabsTrigger>
          </TabsList>
        </SettingsRow>
      ) : null}
      <SettingsRow
        key="secret"
        label={m.variables_secret()}
        htmlFor={`${id}-secret`}
        description={
          change.explicitValue
            ? m.variables_explicit_value()
            : change.gitHistory && !change.gitToLocal
              ? m.variables_git_history()
              : m.variables_secret_description()
        }
        data-disabled={disabled || Boolean(fixedKind)}
      >
        <Switch
          id={`${id}-secret`}
          checked={draft.kind === "secret"}
          disabled={disabled || Boolean(fixedKind)}
          onCheckedChange={(secret) => onChange(withSecret(draft, secret))}
        />
      </SettingsRow>
    </SettingsRows>
  );
  return scoped ? (
    <Tabs
      className="gap-0"
      value={draft.storage}
      onValueChange={(storage) => {
        if (!disabled && (storage === "local" || storage === "git"))
          onChange({ ...draft, storage });
      }}
    >
      {rows}
    </Tabs>
  ) : (
    rows
  );
}

function VariableFieldCompact({
  draft,
  disabled,
  onChange,
  showOwner = true,
  fixedKind,
  collisionAlternatives,
}: AppVariableFieldsProps) {
  const id = useId();
  const invalid = draft.name.length > 0 && !validVariableName(draft.name);
  const change = transitions(draft);
  const secretControl = (
    <Field className="w-auto" data-disabled={disabled || Boolean(fixedKind)}>
      <FieldLabel htmlFor={`${id}-secret`}>{m.variables_secret()}</FieldLabel>
      <div className="flex h-8 items-center">
        <Switch
          id={`${id}-secret`}
          checked={draft.kind === "secret"}
          disabled={disabled || Boolean(fixedKind)}
          onCheckedChange={(secret) => onChange(withSecret(draft, secret))}
        />
      </div>
    </Field>
  );
  const valueFields = (
    <>
      {!draft.editing ? (
        <Field
          className="col-span-2 min-w-0"
          data-invalid={invalid}
          data-disabled={disabled || draft.editing}
        >
          <FieldLabel htmlFor={`${id}-name`}>
            {m.settings_variables_name()}
          </FieldLabel>
          <Input
            id={`${id}-name`}
            value={draft.name}
            placeholder="API_TOKEN"
            aria-describedby={invalid ? `${id}-name-hint` : undefined}
            disabled={disabled || draft.editing}
            aria-invalid={invalid}
            autoCorrect="off"
            autoCapitalize="off"
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
      <Field className="col-span-2 min-w-0" data-disabled={disabled}>
        <FieldLabel htmlFor={`${id}-value`}>
          {m.settings_variables_value()}
        </FieldLabel>
        <Input
          id={`${id}-value`}
          autoFocus
          type={draft.kind === "secret" ? "password" : "text"}
          value={draft.value}
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => onChange(withValue(draft, event.target.value))}
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
      <FieldGroup className="grid grid-cols-2 items-start gap-4">
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
      {change.gitToLocal ? (
        <p className="text-xs text-muted-foreground">
          {m.variables_git_to_local()}
        </p>
      ) : null}
      {change.gitHistory ? (
        <p className="text-xs text-muted-foreground">
          {m.variables_git_history()}
        </p>
      ) : null}
      {change.explicitValue ? (
        <p className="text-xs text-muted-foreground">
          {m.variables_explicit_value()}
        </p>
      ) : null}
    </FieldGroup>
  );
  return (
    <FieldGroup className="gap-3">
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
          <CollisionChoice
            draft={draft}
            disabled={disabled}
            onChange={onChange}
            alternatives={collisionAlternatives}
            labelledBy={`${id}-conflict`}
          />
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

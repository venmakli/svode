import type { AgentActorOption } from "@/features/actors";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import * as m from "@/paraglide/messages.js";

import { validateRoutineDraft } from "../model/routine-draft";
import type { RoutineDefinition } from "../model/types";
import { RoutineActionFields } from "./routine-action-fields";
import { RoutineContentField } from "./routine-content-field";
import { RoutineIdentityFields } from "./routine-identity-fields";
import { RoutineTriggerFields } from "./routine-trigger-fields";

export function RoutineDefinitionForm({
  collectionOwner,
  definition,
  executorError,
  executors,
  formId,
  onChange,
  onSubmit,
}: {
  collectionOwner: boolean;
  definition: RoutineDefinition;
  executorError: string | null;
  executors: readonly AgentActorOption[];
  formId: string;
  onChange(definition: RoutineDefinition): void;
  onSubmit(): void;
}) {
  const issues = validateRoutineDraft(definition);
  const action = definition.action;
  const executorUnavailable =
    action.type === "run_agent" &&
    (!action.executor ||
      !executors.some((option) => option.value === action.executor));
  return (
    <form
      id={formId}
      className="flex min-h-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          issues.size === 0 &&
          definition.name.trim() &&
          !executorUnavailable &&
          !executorError
        ) {
          onSubmit();
        }
      }}
    >
      <FieldGroup>
        <RoutineIdentityFields
          autoFocus
          definition={definition}
          idPrefix={formId}
          onChange={onChange}
        />
        {definition.trigger.type !== "manual" ? (
          <Field orientation="horizontal">
            <Switch
              id={`${formId}-enabled`}
              checked={definition.enabled === true}
              onCheckedChange={(enabled) =>
                onChange({ ...definition, enabled: enabled === true })
              }
            />
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor={`${formId}-enabled`}>
                {m.routines_enabled_label()}
              </FieldLabel>
              <FieldDescription>{m.routines_enabled_hint()}</FieldDescription>
            </div>
          </Field>
        ) : null}
      </FieldGroup>

      <FieldSet>
        <FieldLegend>{m.routines_trigger_section()}</FieldLegend>
        <RoutineTriggerFields
          collectionOwner={collectionOwner}
          definition={definition}
          idPrefix={formId}
          issues={issues}
          onChange={onChange}
        />
      </FieldSet>

      <FieldSet>
        <FieldLegend>{m.routines_action_section()}</FieldLegend>
        <RoutineActionFields
          definition={definition}
          executorError={executorError}
          executors={executors}
          idPrefix={formId}
          issues={issues}
          onChange={onChange}
        />
      </FieldSet>

      <RoutineContentField
        definition={definition}
        editorKey={formId}
        onChange={onChange}
      />
    </form>
  );
}

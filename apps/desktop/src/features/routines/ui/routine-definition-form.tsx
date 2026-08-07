import type { AgentActorOption } from "@/features/actors";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ControlledMarkdownEditor } from "@/features/editor";
import * as m from "@/paraglide/messages.js";

import { validateRoutineDraft } from "../model/routine-draft";
import type { RoutineDefinition } from "../model/types";
import { RoutineActionFields } from "./routine-action-fields";
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
          definition.title.trim() &&
          !executorUnavailable &&
          !executorError
        ) {
          onSubmit();
        }
      }}
    >
      <FieldGroup>
        <Field data-invalid={!definition.title.trim()}>
          <FieldLabel htmlFor={`${formId}-title`}>
            {m.routines_title_label()}
          </FieldLabel>
          <Input
            id={`${formId}-title`}
            autoFocus
            aria-invalid={!definition.title.trim()}
            value={definition.title}
            onChange={(event) =>
              onChange({ ...definition, title: event.target.value })
            }
          />
          {!definition.title.trim() ? (
            <FieldError>{m.routines_title_required()}</FieldError>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${formId}-description`}>
            {m.routines_description_label()}
          </FieldLabel>
          <Textarea
            id={`${formId}-description`}
            value={definition.description}
            onChange={(event) =>
              onChange({ ...definition, description: event.target.value })
            }
          />
          <FieldDescription>{m.routines_description_hint()}</FieldDescription>
        </Field>
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
          issues={issues}
          onChange={onChange}
        />
      </FieldSet>

      <Field>
        <FieldLabel>
          {definition.action.type === "run_agent"
            ? m.routines_instruction_label()
            : m.routines_rule_description_label()}
        </FieldLabel>
        <ControlledMarkdownEditor
          key={formId}
          value={definition.body}
          placeholder={
            definition.action.type === "run_agent"
              ? m.routines_body_hint()
              : m.routines_rule_body_hint()
          }
          onChange={(body) => onChange({ ...definition, body })}
        />
      </Field>
    </form>
  );
}

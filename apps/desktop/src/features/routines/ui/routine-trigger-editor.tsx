import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as m from "@/paraglide/messages.js";

import {
  changeRoutineEvent,
  changeRoutineTrigger,
  parseRoutineValueInput,
  routineValueInput,
  validateRoutineDraft,
} from "../model/routine-draft";
import {
  applyRoutineTriggerDraft,
  routineTriggerDraft,
  routineTriggerNeedsConsent,
  type RoutineTriggerDraft,
} from "../model/routine-property-drafts";
import type {
  RoutineDefinition,
  RoutineEventType,
  RoutineTriggerType,
} from "../model/types";
import { RoutineScheduleFields } from "./routine-schedule-fields";

/**
 * The editor of "Trigger" in its popover: the type, the schedule or the
 * event, and the consent to run automatically once the type turns to a
 * schedule or an event. Nothing is saved until the popover closes.
 */
export function RoutineTriggerEditor({
  collectionOwner,
  draft,
  saved,
  onChange,
}: {
  collectionOwner: boolean;
  draft: RoutineTriggerDraft;
  /** The saved definition the popover opened with. */
  saved: RoutineDefinition;
  onChange(draft: RoutineTriggerDraft): void;
}) {
  const idPrefix = useId();
  const definition = applyRoutineTriggerDraft(saved, draft);
  const issues = validateRoutineDraft(definition);
  const change = (next: RoutineDefinition) =>
    onChange({
      action: next.action,
      automaticConsent:
        next.trigger.type === definition.trigger.type
          ? draft.automaticConsent
          : false,
      enabled: next.enabled,
      trigger: next.trigger,
    });
  const consent = routineTriggerNeedsConsent(saved, draft);
  const trigger = definition.trigger;
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-type`}>
          {m.routines_trigger_label()}
        </FieldLabel>
        <Select
          value={definition.trigger.type}
          onValueChange={(value) => {
            if (value === definition.trigger.type) return;
            const type = value as RoutineTriggerType;
            change(
              type === saved.trigger.type
                ? applyRoutineTriggerDraft(saved, routineTriggerDraft(saved))
                : changeRoutineTrigger(definition, type),
            );
          }}
        >
          <SelectTrigger id={`${idPrefix}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="manual">
                {m.routines_trigger_manual()}
              </SelectItem>
              <SelectItem value="schedule">
                {m.routines_trigger_schedule()}
              </SelectItem>
              {collectionOwner ? (
                <SelectItem value="event">
                  {m.routines_trigger_event()}
                </SelectItem>
              ) : null}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {trigger.type === "schedule" ? (
        <RoutineScheduleFields
          trigger={trigger}
          issues={issues}
          idPrefix={idPrefix}
          onChange={(nextTrigger) =>
            change({ ...definition, trigger: nextTrigger })
          }
        />
      ) : null}

      {trigger.type === "event" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-event`}>
              {m.routines_event_type_label()}
            </FieldLabel>
            <Select
              value={trigger.event}
              onValueChange={(event) => {
                if (event === trigger.event) return;
                change(
                  changeRoutineEvent(definition, event as RoutineEventType),
                );
              }}
            >
              <SelectTrigger id={`${idPrefix}-event`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="collection.entry_created">
                    {m.routines_event_created()}
                  </SelectItem>
                  <SelectItem value="collection.field_changed">
                    {m.routines_event_field_changed()}
                  </SelectItem>
                  <SelectItem value="collection.entry_deleted">
                    {m.routines_event_deleted()}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {trigger.event === "collection.field_changed" ? (
            <FieldGroup>
              <Field data-invalid={issues.has("event_field")}>
                <FieldLabel htmlFor={`${idPrefix}-event-field`}>
                  {m.routines_event_field_label()}
                </FieldLabel>
                <Input
                  id={`${idPrefix}-event-field`}
                  value={trigger.match?.field ?? ""}
                  aria-invalid={issues.has("event_field")}
                  onChange={(event) =>
                    change({
                      ...definition,
                      trigger: {
                        ...trigger,
                        match: {
                          ...trigger.match,
                          field: event.target.value,
                        },
                      },
                    })
                  }
                />
                {issues.has("event_field") ? (
                  <FieldError>{m.routines_event_field_required()}</FieldError>
                ) : null}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor={`${idPrefix}-event-from`}>
                    {m.routines_event_from_label()}
                  </FieldLabel>
                  <Input
                    id={`${idPrefix}-event-from`}
                    value={routineValueInput(trigger.match?.from ?? "")}
                    onChange={(event) =>
                      change({
                        ...definition,
                        trigger: {
                          ...trigger,
                          match: {
                            field: trigger.match?.field ?? "",
                            from: parseRoutineValueInput(event.target.value),
                            to: trigger.match?.to,
                          },
                        },
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${idPrefix}-event-to`}>
                    {m.routines_event_to_label()}
                  </FieldLabel>
                  <Input
                    id={`${idPrefix}-event-to`}
                    value={routineValueInput(trigger.match?.to ?? "")}
                    onChange={(event) =>
                      change({
                        ...definition,
                        trigger: {
                          ...trigger,
                          match: {
                            field: trigger.match?.field ?? "",
                            from: trigger.match?.from,
                            to: parseRoutineValueInput(event.target.value),
                          },
                        },
                      })
                    }
                  />
                </Field>
              </div>
            </FieldGroup>
          ) : null}
        </>
      ) : null}
      {consent ? (
        <Field orientation="horizontal" data-routine-automatic-consent>
          <Checkbox
            id={`${idPrefix}-automatic-consent`}
            checked={draft.automaticConsent}
            onCheckedChange={(checked) =>
              onChange({ ...draft, automaticConsent: checked === true })
            }
          />
          <FieldContent>
            <FieldLabel htmlFor={`${idPrefix}-automatic-consent`}>
              {m.routines_automatic_consent_label()}
            </FieldLabel>
            <FieldDescription>
              {m.routines_automatic_consent_description()}
            </FieldDescription>
          </FieldContent>
        </Field>
      ) : null}
    </FieldGroup>
  );
}

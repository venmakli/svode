import {
  Field,
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
  type RoutineDraftIssue,
} from "../model/routine-draft";
import type {
  RoutineDefinition,
  RoutineEventType,
  RoutineTriggerType,
} from "../model/types";

export function RoutineTriggerFields({
  collectionOwner,
  definition,
  issues,
  onChange,
}: {
  collectionOwner: boolean;
  definition: RoutineDefinition;
  issues: ReadonlySet<RoutineDraftIssue>;
  onChange(definition: RoutineDefinition): void;
}) {
  const trigger = definition.trigger;
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>{m.routines_trigger_label()}</FieldLabel>
        <Select
          value={definition.trigger.type}
          onValueChange={(value) => {
            if (value === definition.trigger.type) return;
            if (!window.confirm(m.routines_change_type_confirm())) return;
            onChange(
              changeRoutineTrigger(
                definition,
                value as RoutineTriggerType,
                Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              ),
            );
          }}
        >
          <SelectTrigger className="w-full">
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
        <>
          <Field data-invalid={issues.has("cron")}>
            <FieldLabel htmlFor="routine-cron">
              {m.routines_cron_label()}
            </FieldLabel>
            <Input
              id="routine-cron"
              value={trigger.cron}
              aria-invalid={issues.has("cron")}
              onChange={(event) =>
                onChange({
                  ...definition,
                  trigger: {
                    ...trigger,
                    cron: event.target.value,
                  },
                })
              }
            />
            {issues.has("cron") ? (
              <FieldError>{m.routines_cron_required()}</FieldError>
            ) : (
              <FieldDescription>{m.routines_cron_hint()}</FieldDescription>
            )}
          </Field>
          <Field data-invalid={issues.has("timezone")}>
            <FieldLabel htmlFor="routine-timezone">
              {m.routines_timezone_label()}
            </FieldLabel>
            <Input
              id="routine-timezone"
              value={trigger.timezone}
              aria-invalid={issues.has("timezone")}
              onChange={(event) =>
                onChange({
                  ...definition,
                  trigger: {
                    ...trigger,
                    timezone: event.target.value,
                  },
                })
              }
            />
            {issues.has("timezone") ? (
              <FieldError>{m.routines_timezone_required()}</FieldError>
            ) : (
              <FieldDescription>{m.routines_timezone_hint()}</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel>{m.routines_missed_runs_label()}</FieldLabel>
            <Select
              value={trigger.missedRuns}
              onValueChange={(missedRuns) =>
                onChange({
                  ...definition,
                  trigger: {
                    ...trigger,
                    missedRuns: missedRuns as "skip" | "run_once",
                  },
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="skip">
                    {m.routines_missed_runs_skip()}
                  </SelectItem>
                  <SelectItem value="run_once">
                    {m.routines_missed_runs_run_once()}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </>
      ) : null}

      {trigger.type === "event" ? (
        <>
          <Field>
            <FieldLabel>{m.routines_event_type_label()}</FieldLabel>
            <Select
              value={trigger.event}
              onValueChange={(event) => {
                if (event === trigger.event) return;
                if (!window.confirm(m.routines_change_type_confirm())) return;
                onChange(
                  changeRoutineEvent(definition, event as RoutineEventType),
                );
              }}
            >
              <SelectTrigger className="w-full">
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
                <FieldLabel htmlFor="routine-event-field">
                  {m.routines_event_field_label()}
                </FieldLabel>
                <Input
                  id="routine-event-field"
                  value={trigger.match?.field ?? ""}
                  aria-invalid={issues.has("event_field")}
                  onChange={(event) =>
                    onChange({
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
                  <FieldLabel htmlFor="routine-event-from">
                    {m.routines_event_from_label()}
                  </FieldLabel>
                  <Input
                    id="routine-event-from"
                    value={routineValueInput(trigger.match?.from ?? "")}
                    onChange={(event) =>
                      onChange({
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
                  <FieldLabel htmlFor="routine-event-to">
                    {m.routines_event_to_label()}
                  </FieldLabel>
                  <Input
                    id="routine-event-to"
                    value={routineValueInput(trigger.match?.to ?? "")}
                    onChange={(event) =>
                      onChange({
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
    </FieldGroup>
  );
}

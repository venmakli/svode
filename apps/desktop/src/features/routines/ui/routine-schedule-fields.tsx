import { useState } from "react";

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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import * as m from "@/paraglide/messages.js";

import type { RoutineDraftIssue } from "../model/routine-draft";
import {
  changeRoutineSchedulePreset,
  changeRoutineScheduleTime,
  changeRoutineScheduleWeekday,
  routineScheduleEditorValue,
  type RoutineSchedulePreset,
} from "../model/routine-schedule";
import type { RoutineTrigger } from "../model/types";
import { RoutineTimezonePicker } from "./routine-timezone-picker";

const WEEKDAYS = [
  ["1", m.routines_schedule_weekday_monday],
  ["2", m.routines_schedule_weekday_tuesday],
  ["3", m.routines_schedule_weekday_wednesday],
  ["4", m.routines_schedule_weekday_thursday],
  ["5", m.routines_schedule_weekday_friday],
  ["6", m.routines_schedule_weekday_saturday],
  ["0", m.routines_schedule_weekday_sunday],
] as const;

export function RoutineScheduleFields({
  idPrefix,
  issues,
  onChange,
  trigger,
}: {
  idPrefix: string;
  issues: ReadonlySet<RoutineDraftIssue>;
  onChange(trigger: Extract<RoutineTrigger, { type: "schedule" }>): void;
  trigger: Extract<RoutineTrigger, { type: "schedule" }>;
}) {
  const editor = routineScheduleEditorValue(trigger.cron);
  const [mode, setMode] = useState<RoutineSchedulePreset>(editor.preset);
  const visibleEditor =
    mode === "advanced" ? { ...editor, preset: mode } : editor;
  return (
    <FieldGroup>
      <Field>
        <FieldLabel>{m.routines_schedule_preset_label()}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          value={visibleEditor.preset}
          className="w-full flex-wrap justify-start"
          onValueChange={(value) => {
            if (!value) return;
            const preset = value as RoutineSchedulePreset;
            setMode(preset);
            onChange(changeRoutineSchedulePreset(trigger, preset));
          }}
        >
          <ToggleGroupItem value="daily">
            {m.routines_schedule_preset_daily()}
          </ToggleGroupItem>
          <ToggleGroupItem value="weekdays">
            {m.routines_schedule_preset_weekdays()}
          </ToggleGroupItem>
          <ToggleGroupItem value="weekly">
            {m.routines_schedule_preset_weekly()}
          </ToggleGroupItem>
          <ToggleGroupItem value="advanced">
            {m.routines_schedule_preset_advanced()}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      {visibleEditor.preset === "advanced" ? (
        <Field data-invalid={issues.has("cron")}>
          <FieldLabel htmlFor={`${idPrefix}-cron`}>
            {m.routines_cron_label()}
          </FieldLabel>
          <Input
            id={`${idPrefix}-cron`}
            data-routine-create-focus="trigger"
            value={trigger.cron}
            aria-invalid={issues.has("cron")}
            onChange={(event) =>
              onChange({ ...trigger, cron: event.target.value })
            }
          />
          {issues.has("cron") ? (
            <FieldError>{m.routines_cron_required()}</FieldError>
          ) : (
            <FieldDescription>{m.routines_cron_hint()}</FieldDescription>
          )}
        </Field>
      ) : (
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-schedule-time`}>
              {m.routines_schedule_time_label()}
            </FieldLabel>
            <Input
              id={`${idPrefix}-schedule-time`}
              type="time"
              value={editor.time}
              onChange={(event) =>
                onChange(changeRoutineScheduleTime(trigger, event.target.value))
              }
            />
          </Field>
          {editor.preset === "weekly" ? (
            <Field>
              <FieldLabel>{m.routines_schedule_weekday_label()}</FieldLabel>
              <Select
                value={editor.weekday}
                onValueChange={(weekday) =>
                  onChange(changeRoutineScheduleWeekday(trigger, weekday))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {WEEKDAYS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label()}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </FieldGroup>
      )}

      <Field data-invalid={issues.has("timezone")}>
        <FieldLabel htmlFor={`${idPrefix}-timezone`}>
          {m.routines_timezone_label()}
        </FieldLabel>
        <RoutineTimezonePicker
          id={`${idPrefix}-timezone`}
          value={trigger.timeBasis}
          invalid={issues.has("timezone")}
          onChange={(timeBasis) => onChange({ ...trigger, timeBasis })}
        />
        {issues.has("timezone") ? (
          <FieldError>{m.routines_timezone_unknown()}</FieldError>
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
              ...trigger,
              missedRuns: missedRuns as "skip" | "run_once",
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
    </FieldGroup>
  );
}

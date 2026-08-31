import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ControlledMarkdownEditor } from "@/features/editor";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import {
  routineActionSummary,
  routineTriggerSummary,
} from "../model/routine-values";
import type { RoutineRow } from "../model/types";
import { RoutineDiagnostics } from "./routine-diagnostics";
import {
  routineNextRunCopy,
  routineScheduleSummary,
} from "./routine-schedule-copy";

export function RoutineDetailView({ row }: { row: RoutineRow }) {
  if (!row.valid || !row.definition) {
    return (
      <div className="flex flex-col gap-4">
        <RoutineNameConflictNotice row={row} />
        <RoutineDiagnostics diagnostics={row.diagnostics} />
        <DetailValue label={m.routines_definition_path_label()}>
          {row.definitionPath}
        </DetailValue>
      </div>
    );
  }

  const nextRunCopy = routineNextRunCopy(row);

  return (
    <div className="flex flex-col gap-5">
      <RoutineNameConflictNotice row={row} />
      {row.diagnostics.length > 0 ? (
        <RoutineDiagnostics diagnostics={row.diagnostics} />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <DetailValue label={m.routines_field_trigger()}>
          <Badge variant="secondary">
            {row.definition.trigger.type === "schedule"
              ? routineScheduleSummary(row.definition.trigger)
              : routineTriggerSummary(row)}
          </Badge>
        </DetailValue>
        <DetailValue label={m.routines_field_action()}>
          <Badge variant="secondary">{routineActionSummary(row)}</Badge>
        </DetailValue>
        <DetailValue label={m.routines_field_enabled()}>
          {row.definition.trigger.type === "manual"
            ? m.routines_not_applicable()
            : row.definition.enabled
              ? m.routines_enabled_yes()
              : m.routines_enabled_no()}
        </DetailValue>
        <DetailValue label={m.routines_field_executor()}>
          {row.definition.action.type === "run_agent"
            ? row.definition.action.executor
            : m.routines_not_applicable()}
        </DetailValue>
        {row.lastRunAt ? (
          <DetailValue label={m.routines_field_last_run()}>
            <span className="flex flex-wrap items-center gap-2">
              <time dateTime={row.lastRunAt}>
                {formatRoutineRunDate(row.lastRunAt)}
              </time>
              {row.lastRunOrigin === "remote" ? (
                <Badge variant="outline">{m.routines_last_run_remote()}</Badge>
              ) : null}
            </span>
          </DetailValue>
        ) : null}
        {nextRunCopy ? (
          <DetailValue label={m.routines_field_next_run()}>
            <time dateTime={row.nextRunAt ?? undefined}>{nextRunCopy}</time>
          </DetailValue>
        ) : null}
      </div>
      <Separator />
      <DetailValue
        label={
          row.definition.action.type === "run_agent"
            ? m.routines_instruction_label()
            : m.routines_rule_description_label()
        }
      >
        <ControlledMarkdownEditor
          key={row.fingerprint}
          disabled
          value={row.definition.body}
          placeholder={m.routines_instruction_empty()}
          onChange={() => undefined}
        />
      </DetailValue>
    </div>
  );
}

function RoutineNameConflictNotice({ row }: { row: RoutineRow }) {
  if (!row.nameConflict) return null;
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{m.routines_name_conflict_title()}</AlertTitle>
      <AlertDescription>
        {m.routines_name_conflict_detail({ path: row.definitionPath })}
      </AlertDescription>
    </Alert>
  );
}

function formatRoutineRunDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function DetailValue({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words text-sm">{children}</div>
    </div>
  );
}

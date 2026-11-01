import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AgentActorReferenceValue,
  resolveAgentActorReference,
  type AgentActorOptionsState,
} from "@/features/actors/agent-reference";
import { ControlledMarkdownEditor } from "@/features/editor";
import * as m from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";

import {
  routineActionSummary,
  routineDefinitionDiagnostics,
  routineTriggerSummary,
} from "../model/routine-values";
import { routineAgentActorId } from "../model/launch-refusal";
import type { RoutineLaunchRecoveryActions, RoutineItem } from "../model/types";
import { RoutineDiagnostics } from "./routine-diagnostics";
import { RoutineLaunchRefusalNotice } from "./routine-launch-refusal";
import {
  routineNextRunCopy,
  routineScheduleSummary,
} from "./routine-schedule-copy";

export function RoutineDetailView({
  executors,
  recovery = {},
  item,
}: {
  executors: AgentActorOptionsState;
  recovery?: RoutineLaunchRecoveryActions;
  item: RoutineItem;
}) {
  if (
    !item.definition ||
    item.routineId === null ||
    routineDefinitionDiagnostics(item).length > 0
  ) {
    return (
      <div className="flex flex-col gap-4">
        <RoutineNameConflictNotice item={item} />
        <RoutineDiagnostics diagnostics={item.diagnostics} />
        <DetailValue label={m.routines_definition_path_label()}>
          {item.definitionPath}
        </DetailValue>
      </div>
    );
  }

  const nextRunCopy = routineNextRunCopy(item);

  return (
    <div className="flex flex-col gap-5">
      <RoutineNameConflictNotice item={item} />
      <div className="grid gap-4 sm:grid-cols-2">
        <DetailValue label={m.routines_field_trigger()}>
          <Badge variant="secondary">
            {item.definition.trigger.type === "schedule"
              ? routineScheduleSummary(item.definition.trigger)
              : routineTriggerSummary(item)}
          </Badge>
        </DetailValue>
        <DetailValue label={m.routines_field_action()}>
          <Badge variant="secondary">{routineActionSummary(item)}</Badge>
        </DetailValue>
        <DetailValue label={m.routines_field_enabled()}>
          {item.definition.trigger.type === "manual"
            ? m.routines_not_applicable()
            : item.definition.enabled
              ? m.routines_enabled_yes()
              : m.routines_enabled_no()}
        </DetailValue>
        <DetailValue label={m.routines_field_executor()}>
          {item.definition.action.type === "run_agent" ? (
            <RoutineExecutorValue
              executors={executors}
              reference={item.definition.action.executor}
            />
          ) : (
            m.routines_not_applicable()
          )}
        </DetailValue>
        {item.lastRunAt ? (
          <DetailValue label={m.routines_field_last_run()}>
            <span className="flex flex-wrap items-center gap-2">
              <time dateTime={item.lastRunAt}>
                {formatRoutineRunDate(item.lastRunAt)}
              </time>
              {item.lastRunOrigin === "remote" ? (
                <Badge variant="outline">{m.routines_last_run_remote()}</Badge>
              ) : null}
            </span>
            {item.lastRun?.refusal ? (
              <span className="mt-1 flex text-destructive">
                <RoutineLaunchRefusalNotice
                  actorId={routineAgentActorId(item)}
                  recovery={recovery}
                  refusal={item.lastRun.refusal}
                />
              </span>
            ) : null}
          </DetailValue>
        ) : null}
        {nextRunCopy ? (
          <DetailValue label={m.routines_field_next_run()}>
            <time dateTime={item.nextRunAt ?? undefined}>{nextRunCopy}</time>
          </DetailValue>
        ) : null}
      </div>
      <Separator />
      <DetailValue
        label={
          item.definition.action.type === "run_agent"
            ? m.routines_instruction_label()
            : m.routines_rule_description_label()
        }
      >
        <ControlledMarkdownEditor
          key={item.fingerprint}
          disabled
          value={item.definition.body}
          placeholder={m.routines_instruction_empty()}
          onChange={() => undefined}
        />
      </DetailValue>
    </div>
  );
}

function RoutineExecutorValue({
  executors,
  reference,
}: {
  executors: AgentActorOptionsState;
  reference: string;
}) {
  const resolved = resolveAgentActorReference(executors, reference);
  const recovery =
    resolved.status === "missing" || resolved.status === "ambiguous";
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <AgentActorReferenceValue reference={resolved} />
      {recovery ? (
        <span className="break-all text-xs text-muted-foreground">
          {reference}
        </span>
      ) : null}
    </span>
  );
}

function RoutineNameConflictNotice({ item }: { item: RoutineItem }) {
  if (!item.nameConflict) return null;
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>{m.routines_name_conflict_title()}</AlertTitle>
      <AlertDescription>
        {m.routines_name_conflict_detail({ path: item.definitionPath })}
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

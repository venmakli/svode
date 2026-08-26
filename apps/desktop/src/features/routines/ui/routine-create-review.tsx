import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { AgentActorOption } from "@/features/actors";
import * as m from "@/paraglide/messages.js";

import type { RoutineCreateStep } from "../model/routine-create";
import type { RoutineDefinition } from "../model/types";
import { routineScheduleSummary } from "./routine-schedule-copy";

export function RoutineCreateReview({
  automaticAuthority,
  definition,
  executors,
  ownerLabel,
  onEdit,
}: {
  automaticAuthority: boolean | null;
  definition: RoutineDefinition;
  executors: readonly AgentActorOption[];
  ownerLabel: string;
  onEdit(step: Exclude<RoutineCreateStep, "review">): void;
}) {
  return (
    <div className="flex flex-col gap-4" data-routine-create-review>
      <ReviewSection
        title={m.routines_create_step_basics()}
        onEdit={() => onEdit("basics")}
      >
        <ReviewValue label={m.routines_create_owner_label()}>
          {ownerLabel}
        </ReviewValue>
        <ReviewValue label={m.routines_title_label()}>
          {definition.name.trim()}
        </ReviewValue>
        {definition.description.trim() ? (
          <ReviewValue label={m.routines_description_label()}>
            {definition.description.trim()}
          </ReviewValue>
        ) : null}
      </ReviewSection>
      <Separator />
      <ReviewSection
        title={m.routines_create_step_trigger()}
        onEdit={() => onEdit("trigger")}
      >
        <Badge variant="secondary" className="self-start">
          {triggerSummary(definition)}
        </Badge>
      </ReviewSection>
      <Separator />
      <ReviewSection
        title={m.routines_create_step_action()}
        onEdit={() => onEdit("action")}
      >
        <ReviewValue label={m.routines_field_action()}>
          {definition.action.type === "run_agent"
            ? m.routines_action_run_agent()
            : m.routines_action_update_properties()}
        </ReviewValue>
        {definition.action.type === "run_agent" ? (
          <ReviewValue label={m.routines_field_executor()}>
            {executorLabel(definition, executors)}
          </ReviewValue>
        ) : (
          <ReviewValue label={m.routines_properties_set_label()}>
            <span className="flex flex-col gap-1">
              {Object.entries(definition.action.set).map(([key, value]) => (
                <span key={key} className="break-words">
                  <span className="font-medium">{key}</span>:{" "}
                  {formatValue(value)}
                </span>
              ))}
            </span>
          </ReviewValue>
        )}
        <ReviewValue
          label={
            definition.action.type === "run_agent"
              ? m.routines_instruction_label()
              : m.routines_rule_description_label()
          }
        >
          {definition.body.trim()
            ? summarizeContent(definition.body)
            : m.routines_instruction_empty()}
        </ReviewValue>
      </ReviewSection>
      {definition.trigger.type !== "manual" ? (
        <Alert>
          <AlertTitle>{m.routines_create_review_disabled()}</AlertTitle>
          <AlertDescription>
            {m.routines_create_review_authority({
              authority:
                automaticAuthority === null
                  ? m.routines_create_authority_unknown()
                  : automaticAuthority
                    ? m.routines_create_authority_on()
                    : m.routines_create_authority_off(),
            })}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function executorLabel(
  definition: RoutineDefinition,
  executors: readonly AgentActorOption[],
) {
  if (definition.action.type !== "run_agent") return "";
  const executor = definition.action.executor;
  return (
    executors.find((option) => option.value === executor)?.label ?? executor
  );
}

function ReviewSection({
  children,
  title,
  onEdit,
}: {
  children: ReactNode;
  title: string;
  onEdit(): void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
          {m.routines_create_edit()}
        </Button>
      </div>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function ReviewValue({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function triggerSummary(definition: RoutineDefinition) {
  const trigger = definition.trigger;
  if (trigger.type === "manual") return m.routines_trigger_manual();
  if (trigger.type === "schedule") {
    return routineScheduleSummary(trigger);
  }
  if (trigger.event === "collection.entry_created") {
    return `${m.routines_trigger_event()} · ${m.routines_event_created()}`;
  }
  if (trigger.event === "collection.entry_deleted") {
    return `${m.routines_trigger_event()} · ${m.routines_event_deleted()}`;
  }
  return `${m.routines_trigger_event()} · ${m.routines_event_field_changed()} · ${trigger.match?.field ?? ""}`;
}

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

function summarizeContent(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

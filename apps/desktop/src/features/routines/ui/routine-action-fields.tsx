import type { AgentActorOption } from "@/features/actors";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
  changeRoutineAction,
  type RoutineDraftIssue,
} from "../model/routine-draft";
import type { RoutineDefinition } from "../model/types";
import { RoutinePropertySetEditor } from "./routine-property-set-editor";

export function RoutineActionFields({
  definition,
  executorError,
  executors,
  issues,
  onChange,
}: {
  definition: RoutineDefinition;
  executorError: string | null;
  executors: readonly AgentActorOption[];
  issues: ReadonlySet<RoutineDraftIssue>;
  onChange(definition: RoutineDefinition): void;
}) {
  const allowUpdateProperties =
    definition.trigger.type === "event" &&
    definition.trigger.event !== "collection.entry_deleted";
  const action = definition.action;
  const missingExecutor =
    action.type === "run_agent" &&
    Boolean(action.executor) &&
    !executors.some((option) => option.value === action.executor);

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>{m.routines_action_type_label()}</FieldLabel>
        <Select
          value={definition.action.type}
          onValueChange={(value) => {
            if (value === definition.action.type) return;
            if (!window.confirm(m.routines_change_type_confirm())) return;
            onChange(
              changeRoutineAction(
                definition,
                value as RoutineDefinition["action"]["type"],
              ),
            );
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="run_agent">
                {m.routines_action_run_agent()}
              </SelectItem>
              {allowUpdateProperties ? (
                <SelectItem value="update_properties">
                  {m.routines_action_update_properties()}
                </SelectItem>
              ) : null}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      {definition.action.type === "run_agent" ? (
        <Field data-invalid={issues.has("executor") || missingExecutor}>
          <FieldLabel>{m.routines_executor_label()}</FieldLabel>
          <Select
            value={definition.action.executor}
            onValueChange={(executor) =>
              onChange({
                ...definition,
                action: { executor, type: "run_agent" },
              })
            }
          >
            <SelectTrigger
              className="w-full"
              aria-invalid={issues.has("executor") || missingExecutor}
            >
              <SelectValue placeholder={m.routines_executor_placeholder()} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {missingExecutor ? (
                  <SelectItem value={definition.action.executor} disabled>
                    {definition.action.executor}
                  </SelectItem>
                ) : null}
                {executors.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label} · {option.ownerLabel}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {executorError ? (
            <FieldError>{executorError}</FieldError>
          ) : missingExecutor ? (
            <FieldError>{m.routines_executor_missing()}</FieldError>
          ) : issues.has("executor") ? (
            <FieldError>{m.routines_executor_required()}</FieldError>
          ) : (
            <FieldDescription>{m.routines_executor_hint()}</FieldDescription>
          )}
        </Field>
      ) : (
        <RoutinePropertySetEditor
          invalid={issues.has("set")}
          value={definition.action.set}
          onChange={(set) =>
            onChange({
              ...definition,
              action: {
                set,
                target: "trigger.entry",
                type: "update_properties",
              },
            })
          }
        />
      )}
    </FieldGroup>
  );
}

import {
  AgentActorReferenceValue,
  agentActorReferenceLabel,
  resolveAgentActorReference,
  type AgentActorOptionsState,
} from "@/features/actors/agent-reference";
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
  executors,
  idPrefix,
  issues,
  onChange,
}: {
  definition: RoutineDefinition;
  executors: AgentActorOptionsState;
  idPrefix: string;
  issues: ReadonlySet<RoutineDraftIssue>;
  onChange(definition: RoutineDefinition): void;
}) {
  const allowUpdateProperties =
    definition.trigger.type === "event" &&
    definition.trigger.event !== "collection.entry_deleted";
  const action = definition.action;
  const executorReference =
    action.type === "run_agent" && action.executor
      ? resolveAgentActorReference(executors, action.executor)
      : null;
  const unresolvedExecutor =
    executorReference?.status === "resolved" ? null : executorReference;
  const executorInvalid =
    issues.has("executor") ||
    unresolvedExecutor?.status === "missing" ||
    unresolvedExecutor?.status === "ambiguous" ||
    unresolvedExecutor?.status === "error";

  return (
    <FieldGroup>
      {allowUpdateProperties ? (
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
            <SelectTrigger
              className="w-full"
              data-routine-create-focus="action"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="run_agent">
                  {m.routines_action_run_agent()}
                </SelectItem>
                <SelectItem value="update_properties">
                  {m.routines_action_update_properties()}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {definition.action.type === "run_agent" ? (
        <Field data-invalid={executorInvalid}>
          <FieldLabel>{m.routines_executor_label()}</FieldLabel>
          <Select
            disabled={executors.loading || Boolean(executors.error)}
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
              data-routine-create-focus="action"
              aria-invalid={executorInvalid}
            >
              <SelectValue placeholder={m.routines_executor_placeholder()} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {unresolvedExecutor ? (
                  <SelectItem value={unresolvedExecutor.reference} disabled>
                    <AgentActorReferenceValue reference={unresolvedExecutor} />
                  </SelectItem>
                ) : null}
                {executors.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <AgentActorReferenceValue
                      reference={resolveAgentActorReference(
                        executors,
                        option.value,
                      )}
                      showOwner
                    />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {executors.error ? (
            <FieldError>{executors.error}</FieldError>
          ) : unresolvedExecutor?.status === "missing" ? (
            <FieldError>{m.routines_executor_missing()}</FieldError>
          ) : unresolvedExecutor?.status === "ambiguous" ? (
            <FieldError>{m.routines_executor_ambiguous()}</FieldError>
          ) : unresolvedExecutor?.status === "error" ? (
            <FieldError>
              {agentActorReferenceLabel(unresolvedExecutor)}
            </FieldError>
          ) : issues.has("executor") ? (
            <FieldError>{m.routines_executor_required()}</FieldError>
          ) : (
            <FieldDescription>{m.routines_executor_hint()}</FieldDescription>
          )}
        </Field>
      ) : (
        <RoutinePropertySetEditor
          idPrefix={idPrefix}
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

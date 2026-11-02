import { useId } from "react";

import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  validateRoutineDraft,
} from "../model/routine-draft";
import type { RoutineAction, RoutineDefinition } from "../model/types";
import { RoutinePropertySetEditor } from "./routine-property-set-editor";

/**
 * Whether the Routine may do something else than run its agent: only an
 * event that leaves an item behind lets it update the item's properties.
 */
export function routineActionChoosable(definition: RoutineDefinition) {
  return (
    definition.trigger.type === "event" &&
    definition.trigger.event !== "collection.entry_deleted"
  );
}

/**
 * The editor of "Action" in its popover: running the agent or updating the
 * properties of the item the event left. Nothing is saved until the popover
 * closes.
 */
export function RoutineActionEditor({
  action,
  saved,
  onChange,
}: {
  action: RoutineAction;
  /** The saved definition the popover opened with. */
  saved: RoutineDefinition;
  onChange(action: RoutineAction): void;
}) {
  const idPrefix = useId();
  const definition = { ...saved, action };
  const issues = validateRoutineDraft(definition);

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-type`}>
          {m.routines_action_type_label()}
        </FieldLabel>
        <Select
          value={action.type}
          onValueChange={(value) => {
            if (value === action.type) return;
            onChange(
              value === saved.action.type
                ? saved.action
                : changeRoutineAction(
                    definition,
                    value as RoutineAction["type"],
                  ).action,
            );
          }}
        >
          <SelectTrigger id={`${idPrefix}-type`} className="w-full">
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

      {action.type === "update_properties" ? (
        <RoutinePropertySetEditor
          idPrefix={idPrefix}
          invalid={issues.has("set")}
          value={action.set}
          onChange={(set) =>
            onChange({
              set,
              target: "trigger.entry",
              type: "update_properties",
            })
          }
        />
      ) : null}
    </FieldGroup>
  );
}

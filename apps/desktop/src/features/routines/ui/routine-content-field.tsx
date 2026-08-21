import { Field, FieldLabel } from "@/components/ui/field";
import { ControlledMarkdownEditor } from "@/features/editor";
import * as m from "@/paraglide/messages.js";

import type { RoutineDefinition } from "../model/types";

export function RoutineContentField({
  definition,
  editorKey,
  onChange,
}: {
  definition: RoutineDefinition;
  editorKey: string;
  onChange(definition: RoutineDefinition): void;
}) {
  return (
    <Field>
      <FieldLabel>
        {definition.action.type === "run_agent"
          ? m.routines_instruction_label()
          : m.routines_rule_description_label()}
      </FieldLabel>
      <ControlledMarkdownEditor
        key={editorKey}
        value={definition.body}
        placeholder={
          definition.action.type === "run_agent"
            ? m.routines_body_hint()
            : m.routines_rule_body_hint()
        }
        onChange={(body) => onChange({ ...definition, body })}
      />
    </Field>
  );
}

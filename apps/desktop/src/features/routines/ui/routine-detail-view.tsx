import { useCallback } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { CollectionPresentationRuntime } from "@/features/collection";
import { CollectionItemProperties } from "@/features/collection/app-shell";
import * as m from "@/paraglide/messages.js";

import { routineDefinitionDiagnostics } from "../model/routine-values";
import type { RoutineItem } from "../model/types";
import type { RoutineInstructionFlush } from "../hooks/use-routine-instruction-autosave";
import { RoutineInstructionEditor } from "./routine-instruction-editor";

/**
 * The properties and the instruction of a Routine on its screen. Its
 * problems are in "Status"; a Routine with problems also shows its
 * definition file, and one that cannot be read shows only that file.
 */
export function RoutineDetailView({
  item,
  presentation,
  readOnly,
  registerInstructionFlush,
  saveInstruction,
}: {
  item: RoutineItem;
  presentation: CollectionPresentationRuntime;
  readOnly: boolean;
  registerInstructionFlush(
    itemId: string,
    flush: RoutineInstructionFlush | null,
  ): void;
  saveInstruction(body: string): Promise<void>;
}) {
  const definition = item.routineId !== null ? item.definition : null;
  const problems = routineDefinitionDiagnostics(item).length > 0;
  const itemId = item.id;
  const registerFlush = useCallback(
    (flush: RoutineInstructionFlush | null) =>
      registerInstructionFlush(itemId, flush),
    [itemId, registerInstructionFlush],
  );

  // The instruction follows the properties as a page's body does, with
  // the body's own top padding.
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-5">
        <RoutineNameConflictNotice item={item} />
        <CollectionItemProperties
          factGroups={
            definition && !problems
              ? []
              : [
                  {
                    facts: [
                      {
                        key: "definition-path",
                        label: m.routines_definition_path_label(),
                        value: { kind: "path", path: item.definitionPath },
                      },
                    ],
                    key: "definition",
                    label: "",
                  },
                ]
          }
          item={item}
          presentation={presentation}
        />
      </div>
      {definition ? (
        <RoutineInstructionEditor
          body={definition.body}
          disabled={readOnly}
          label={
            definition.action.type === "run_agent"
              ? m.routines_instruction_label()
              : m.routines_rule_description_label()
          }
          placeholder={
            definition.action.type === "run_agent"
              ? m.routines_body_hint()
              : m.routines_rule_body_hint()
          }
          registerFlush={registerFlush}
          save={saveInstruction}
        />
      ) : null}
    </div>
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

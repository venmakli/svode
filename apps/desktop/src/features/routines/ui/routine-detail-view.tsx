import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { CollectionPresentationRuntime } from "@/features/collection";
import { CollectionItemProperties } from "@/features/collection/app-shell";
import { ControlledMarkdownEditor } from "@/features/editor";
import * as m from "@/paraglide/messages.js";

import { routineDefinitionDiagnostics } from "../model/routine-values";
import type { RoutineItem } from "../model/types";

/**
 * The properties and the instruction of a Routine on its screen. Its
 * problems are in "Status"; a Routine that cannot be read shows its
 * definition file instead of the instruction.
 */
export function RoutineDetailView({
  item,
  presentation,
}: {
  item: RoutineItem;
  presentation: CollectionPresentationRuntime;
}) {
  const readable =
    item.definition !== null &&
    item.routineId !== null &&
    routineDefinitionDiagnostics(item).length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <RoutineNameConflictNotice item={item} />
      <CollectionItemProperties
        factGroups={
          readable
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
      {readable && item.definition ? (
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {item.definition.action.type === "run_agent"
              ? m.routines_instruction_label()
              : m.routines_rule_description_label()}
          </h3>
          <ControlledMarkdownEditor
            key={item.fingerprint}
            disabled
            value={item.definition.body}
            placeholder={m.routines_instruction_empty()}
            onChange={() => undefined}
          />
        </section>
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

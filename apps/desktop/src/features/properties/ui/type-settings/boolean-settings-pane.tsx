import * as m from "@/paraglide/messages.js";
import { effectiveBooleanDisplay } from "../../model/boolean";
import type { BooleanDisplay, Column, ColumnPatch } from "../../model/types";
import { ColumnSelect } from "./common";

export function BooleanSettingsPane({
  column,
  pending,
  onPatchColumn,
}: {
  column: Column;
  pending: boolean;
  onPatchColumn: (patch: ColumnPatch) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <ColumnSelect
        label={m.property_boolean_display()}
        value={effectiveBooleanDisplay(column.display)}
        disabled={pending}
        options={[
          {
            value: "checkbox",
            label: m.property_boolean_display_checkbox(),
          },
          {
            value: "switch",
            label: m.property_boolean_display_switch(),
          },
        ]}
        onChange={(display) =>
          void onPatchColumn({ display: display as BooleanDisplay })
        }
      />
    </div>
  );
}

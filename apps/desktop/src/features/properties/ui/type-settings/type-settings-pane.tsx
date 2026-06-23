import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CollectionSchema, Column } from "../../model/types";
import { useColumnTypeSettings } from "../../hooks/use-column-type-settings";
import { ColumnSelect, ToggleRow } from "./common";
import { NumberSettingsPane } from "./number-settings-pane";
import { OptionsPane } from "./options-pane";
import { RelationSettingsPane } from "./relation-settings-pane";
import * as m from "@/paraglide/messages.js";

export function TypeSettingsPane({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
}: {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
}) {
  const { patchColumn, normalizeCounter } = useColumnTypeSettings({
    column,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });

  if (
    column.type === "select" ||
    column.type === "multi_select" ||
    column.type === "status"
  ) {
    return (
      <OptionsPane
        column={column}
        spacePath={spacePath}
        collectionPath={collectionPath}
        projectPath={projectPath}
        onSchemaChange={onSchemaChange}
      />
    );
  }

  if (column.type === "number") {
    return <NumberSettingsPane column={column} onPatchColumn={patchColumn} />;
  }

  if (column.type === "date") {
    return (
      <div className="flex flex-col gap-2 p-3">
        <ColumnSelect
          label={m.table_number_display()}
          value={String(column.display ?? "medium")}
          options={["short", "medium", "long"]}
          onChange={(display) => void patchColumn({ display })}
        />
        <ToggleRow
          label={m.property_date_time()}
          checked={Boolean(column.timeByDefault)}
          onChange={(checked) => void patchColumn({ timeByDefault: checked })}
        />
        <ToggleRow
          label={m.property_date_range()}
          checked={Boolean(column.rangeByDefault)}
          onChange={(checked) =>
            void patchColumn({ rangeByDefault: checked })
          }
        />
      </div>
    );
  }

  if (column.type === "actor") {
    return (
      <div className="flex flex-col gap-2 p-3">
        <ColumnSelect
          label={m.table_actor_source()}
          value={column.display === "all_time" ? "all_time" : "team"}
          options={["team", "all_time"]}
          onChange={(source) =>
            void patchColumn({
              display: source === "all_time" ? "all_time" : null,
            })
          }
        />
        <ToggleRow
          label={m.property_actor_multiple()}
          checked={Boolean(column.multiple)}
          onChange={(checked) => void patchColumn({ multiple: checked })}
        />
      </div>
    );
  }

  if (column.type === "unique_id") {
    return (
      <div className="flex flex-col gap-2 p-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 text-muted-foreground">
            {m.property_unique_id_prefix()}
          </span>
          <Input
            defaultValue={column.prefix ?? ""}
            className="h-8 flex-1"
            placeholder="ISSUE"
            onBlur={(event) =>
              void patchColumn({
                prefix: event.currentTarget.value.trim() || null,
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <div className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {m.property_unique_id_next({
            next: String(column.next ?? 1),
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="self-start"
          onClick={normalizeCounter}
        >
          {m.property_unique_id_normalize()}
        </Button>
      </div>
    );
  }

  if (column.type === "relation") {
    return (
      <RelationSettingsPane
        column={column}
        spacePath={spacePath}
        collectionPath={collectionPath}
        projectPath={projectPath}
        onSchemaChange={onSchemaChange}
        onPatchColumn={patchColumn}
      />
    );
  }

  return null;
}

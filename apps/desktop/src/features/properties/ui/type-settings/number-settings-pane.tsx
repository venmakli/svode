import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import type { Column } from "../../model/types";
import { ColorPicker } from "../color-picker";
import { ColumnSelect, deferStateUpdate } from "./common";
import * as m from "@/paraglide/messages.js";

export function NumberSettingsPane({
  column,
  onPatchColumn,
}: {
  column: Column;
  onPatchColumn: (patch: Record<string, unknown>) => void;
}) {
  const [min, setMin] = useState(column.min == null ? "" : String(column.min));
  const [max, setMax] = useState(column.max == null ? "" : String(column.max));

  useEffect(() => {
    return deferStateUpdate(() => {
      setMin(column.min == null ? "" : String(column.min));
      setMax(column.max == null ? "" : String(column.max));
    });
  }, [column.max, column.min]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <ColumnSelect
        label={m.table_number_display()}
        value={String(column.display ?? "number")}
        options={["number", "percent", "bar", "ring"]}
        onChange={(display) => onPatchColumn({ display })}
      />
      {column.display === "bar" || column.display === "ring" ? (
        <>
          <NumberInputRow
            label={m.table_number_min()}
            value={min}
            onChange={setMin}
            onCommit={() => onPatchColumn({ min: nullableNumber(min) })}
          />
          <NumberInputRow
            label={m.table_number_max()}
            value={max}
            onChange={setMax}
            onCommit={() => onPatchColumn({ max: nullableNumber(max) })}
          />
          <label className="flex items-center gap-2 text-sm">
            <span className="w-20 text-muted-foreground">
              {m.table_number_color()}
            </span>
            <ColorPicker
              value={column.color ?? "blue"}
              onChange={(color) => onPatchColumn({ color })}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

function NumberInputRow({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-20 text-muted-foreground">{label}</span>
      <Input
        type="number"
        value={value}
        className="h-8 flex-1"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function nullableNumber(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

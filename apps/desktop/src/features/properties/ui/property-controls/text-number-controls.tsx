import { useEffect, useState, type CSSProperties } from "react";
import { Copy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { colorStyle, valueToString } from "../../lib/utils";
import type { Column } from "../../model/types";
import * as m from "@/paraglide/messages.js";
import {
  copyPropertyValue,
  deferStateUpdate,
  IconAction,
} from "./common";
import type { PropertyControlProps } from "./types";

export function TextControl({
  value,
  invalid,
  disabled,
  onChange,
}: Pick<PropertyControlProps, "value" | "invalid" | "disabled" | "onChange">) {
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  return (
    <div className="group/control relative">
      <Input
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void onChange(draft || null)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        className="pr-8"
      />
      <IconAction
        label={m.property_action_copy()}
        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100"
        onClick={() => copyPropertyValue(draft)}
        disabled={!draft}
      >
        <Copy />
      </IconAction>
    </div>
  );
}

export function NumberControl({
  column,
  value,
  invalid,
  disabled,
  onChange,
}: PropertyControlProps) {
  const display = column.display ?? "number";
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  const numeric = typeof value === "number" ? value : Number(draft);
  const min = column.min ?? 0;
  const max = column.max ?? 100;
  const ratio = max === min ? 0 : ((numeric - min) / (max - min)) * 100;
  const clamped = Number.isFinite(ratio)
    ? Math.min(100, Math.max(0, ratio))
    : 0;
  const outOfRange =
    Number.isFinite(numeric) && (numeric < min || numeric > max);

  if (display === "bar" || display === "ring") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex min-w-0 items-center gap-2">
              <InlineNumberInput
                draft={draft}
                invalid={invalid}
                disabled={disabled}
                onDraftChange={setDraft}
                onCommit={() => commitNumber(draft, onChange)}
              />
              {display === "bar" ? (
                <Progress
                  value={clamped}
                  className="min-w-20 flex-1 **:data-[slot=progress-indicator]:bg-(--property-color)"
                  style={colorStyle(column.color ?? "blue")}
                />
              ) : (
                <RingProgress value={clamped} color={column.color ?? "blue"} />
              )}
            </div>
          </TooltipTrigger>
          {outOfRange ? (
            <TooltipContent>
              {m.property_number_exact_value({ value: String(numeric) })}
            </TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (display === "percent") {
    const percent = max === 0 ? numeric : (numeric / max) * 100;
    return (
      <div className="flex items-center gap-2">
        <InlineNumberInput
          draft={draft}
          invalid={invalid}
          disabled={disabled}
          onDraftChange={setDraft}
          onCommit={() => commitNumber(draft, onChange)}
        />
        <span className="w-14 shrink-0 text-right text-sm text-muted-foreground">
          {Number.isFinite(percent) ? `${Math.round(percent)}%` : ""}
        </span>
      </div>
    );
  }

  return (
    <InlineNumberInput
      draft={draft}
      invalid={invalid}
      disabled={disabled}
      onDraftChange={setDraft}
      onCommit={() => commitNumber(draft, onChange)}
    />
  );
}

function InlineNumberInput({
  draft,
  invalid,
  disabled,
  onDraftChange,
  onCommit,
}: {
  draft: string;
  invalid?: boolean;
  disabled?: boolean;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <Input
      type="number"
      value={draft}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event) => onDraftChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className="min-w-20"
    />
  );
}

function RingProgress({
  value,
  color,
}: {
  value: number;
  color: Column["color"];
}) {
  return (
    <div
      className="grid size-7 shrink-0 place-items-center rounded-full bg-(--property-ring-bg) text-[10px] font-medium text-muted-foreground"
      style={
        {
          ...colorStyle(color ?? "blue"),
          "--progress": `${value}%`,
          "--property-ring-bg":
            "conic-gradient(var(--property-color) var(--progress), var(--muted) 0)",
        } as CSSProperties
      }
    >
      <div className="grid size-5 place-items-center rounded-full bg-background">
        {Math.round(value)}
      </div>
    </div>
  );
}

function commitNumber(
  value: string,
  onChange: PropertyControlProps["onChange"],
) {
  if (value.trim() === "") {
    void onChange(null);
    return;
  }
  const next = Number(value);
  if (Number.isFinite(next)) {
    void onChange(next);
  }
}

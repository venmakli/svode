import { useEffect, useRef, useState } from "react";
import { Database, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  shouldClosePropertyEditorOnChange,
  validatePropertyValue,
} from "@/features/properties/model";
import {
  PropertyControl,
} from "@/features/properties/ui";
import type { Column, Person } from "@/features/properties/model";
import { valueToString } from "@/features/properties/lib";
import {
  NumberPreview,
  PropertyValue,
  PropertyValueActions,
} from "@/features/properties/ui";
import type { CollectionTableRow } from "./types";
import * as m from "@/paraglide/messages.js";

export function PropertyCell({
  column,
  persons,
  onRequestPersons,
  value,
  editing,
  onEdit,
  onCancel,
  onCommit,
}: {
  column: Column;
  persons: Person[];
  onRequestPersons: (allTime: boolean) => Promise<Person[]>;
  value: unknown;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onCommit: (value: unknown, options?: { close?: boolean }) => void;
}) {
  const validation = validatePropertyValue(column, value);

  if (column.type === "checkbox") {
    return (
      <div className="flex h-7 items-center px-1">
        <Checkbox
          checked={Boolean(value)}
          aria-invalid={validation.invalid || undefined}
          onCheckedChange={(checked) => onCommit(checked === true)}
        />
      </div>
    );
  }

  if (editing) {
    return (
      <div
        className="w-full"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        {column.type === "text" ? (
          <DebouncedTextEditor
            value={value}
            invalid={validation.invalid}
            onDraftCommit={(next) => onCommit(next, { close: false })}
            onFinalCommit={(next) => onCommit(next, { close: true })}
            onCancel={(initial) => {
              onCommit(initial, { close: true });
              onCancel();
            }}
          />
        ) : column.type === "number" ? (
          <DebouncedNumberEditor
            column={column}
            value={value}
            invalid={validation.invalid}
            onDraftCommit={(next) => onCommit(next, { close: false })}
            onFinalCommit={(next) => onCommit(next, { close: true })}
            onCancel={(initial) => {
              onCommit(initial, { close: true });
              onCancel();
            }}
          />
        ) : (
          <PropertyControl
            column={column}
            value={value}
            invalid={validation.invalid}
            autoOpen
            persons={persons}
            onChange={(next) =>
              onCommit(next, {
                close: shouldClosePropertyEditorOnChange(column.type),
              })
            }
            onRequestPersons={onRequestPersons}
          />
        )}
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "group/cell flex h-7 w-full items-center gap-1 rounded px-1 text-left text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        validation.invalid && "border border-destructive",
      )}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onEdit();
        }
      }}
    >
      <span className="min-w-0 flex-1 truncate">
        <PropertyValue column={column} value={value} persons={persons} />
      </span>
      <PropertyValueActions column={column} value={value} />
    </div>
  );
}

function DebouncedTextEditor({
  value,
  invalid,
  onDraftCommit,
  onFinalCommit,
  onCancel,
}: {
  value: unknown;
  invalid?: boolean;
  onDraftCommit: (value: unknown) => void;
  onFinalCommit: (value: unknown) => void;
  onCancel: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(valueToString(value));
  const initial = useRef(valueToString(value));
  const cancelled = useRef(false);
  const changed = draft !== initial.current;

  useDebouncedCommit(changed ? draft || null : undefined, onDraftCommit);

  return (
    <Input
      autoFocus
      value={draft}
      aria-invalid={invalid || undefined}
      className="h-7"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (!cancelled.current) onFinalCommit(draft || null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          onCancel(initial.current || null);
        }
      }}
    />
  );
}

function DebouncedNumberEditor({
  column,
  value,
  invalid,
  onDraftCommit,
  onFinalCommit,
  onCancel,
}: {
  column: Column;
  value: unknown;
  invalid?: boolean;
  onDraftCommit: (value: unknown) => void;
  onFinalCommit: (value: unknown) => void;
  onCancel: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(valueToString(value));
  const initial = useRef(valueToString(value));
  const cancelled = useRef(false);
  const numeric = Number(draft);
  const parsed =
    draft.trim() === "" ? null : Number.isFinite(numeric) ? numeric : undefined;
  const changed = draft !== initial.current;
  const display = column.display ?? "number";

  useDebouncedCommit(changed ? parsed : undefined, onDraftCommit);

  return (
    <div className="flex w-full flex-col gap-1">
      <Input
        autoFocus
        type="number"
        value={draft}
        aria-invalid={invalid || parsed === undefined || undefined}
        className="h-7"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!cancelled.current && parsed !== undefined) onFinalCommit(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelled.current = true;
            onCancel(parseNumberDraft(initial.current));
          }
        }}
      />
      {display === "bar" || display === "ring" ? (
        <NumberPreview column={column} value={Number(parsed ?? 0)} />
      ) : null}
    </div>
  );
}

function useDebouncedCommit(
  value: unknown,
  onCommit: (value: unknown) => void,
) {
  useEffect(() => {
    if (value === undefined) return undefined;
    const timer = window.setTimeout(() => onCommit(value), 500);
    return () => window.clearTimeout(timer);
  }, [onCommit, value]);
}

function parseNumberDraft(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function TitleCell({
  row,
  expandable,
  expanded,
  nested,
  onToggle,
  onOpen,
  onOpenNested,
}: {
  row: CollectionTableRow;
  expandable: boolean;
  expanded: boolean;
  nested: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenNested: () => void;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1"
      style={{ paddingLeft: row.level * 18 }}
    >
      <EntryDisclosure
        icon={row.entry.meta.icon}
        expandable={expandable}
        expanded={expanded}
        onToggle={onToggle}
      />
      <button
        type="button"
        title={m.table_open_entry_tooltip()}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        <span className="truncate">{row.entry.meta.title}</span>
      </button>
      {nested ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            onOpenNested();
          }}
        >
          <Database />
          <span className="sr-only">{m.table_open_nested_collection()}</span>
        </Button>
      ) : null}
    </div>
  );
}

function EntryDisclosure({
  icon,
  expandable,
  expanded,
  onToggle,
}: {
  icon: string | null;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!expandable) {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center">
        {icon || "·"}
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="group/disclosure size-6 shrink-0"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className={cn("group-hover/row:hidden", expanded && "hidden")}>
        {icon || "·"}
      </span>
      <ChevronRight
        className={cn(
          "hidden group-hover/row:block",
          expanded && "block",
          expanded && "rotate-90",
        )}
      />
    </Button>
  );
}

import { useRef, useState } from "react";
import { Database, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";
import {
  shouldClosePropertyEditorOnChange,
  validatePropertyValue,
} from "@/features/properties";
import type { Column, ActorCandidate } from "@/features/properties";
import type { RelationContext } from "@/features/properties";
import { valueToString } from "@/features/properties";
import {
  NumberPreview,
  PropertyControl,
  PropertyValue,
  PropertyValueActions,
} from "@/features/properties/ui";
import type { CollectionTableRow } from "./types";
import * as m from "@/paraglide/messages.js";

export function PropertyCell({
  column,
  actors,
  onRequestActors,
  relationContext,
  value,
  editing,
  onEdit,
  onCancel,
  onCommit,
}: {
  column: Column;
  actors: ActorCandidate[];
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  relationContext?: RelationContext;
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
            actors={actors}
            relationContext={relationContext}
            onChange={(next) =>
              onCommit(next, {
                close: shouldClosePropertyEditorOnChange(column.type),
              })
            }
            onOpenChange={(open) => {
              if (!open) window.setTimeout(onCancel, 0);
            }}
            onRequestActors={onRequestActors}
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
        <PropertyValue
          column={column}
          value={value}
          actors={actors}
          relationContext={relationContext}
        />
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
  const [initial] = useState(() => valueToString(value));
  const cancelled = useRef(false);

  return (
    <Input
      autoFocus
      value={draft}
      aria-invalid={invalid || undefined}
      className="h-7"
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (next !== initial) onDraftCommit(next || null);
      }}
      onBlur={() => {
        if (!cancelled.current) onFinalCommit(draft || null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          onCancel(initial || null);
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
  const [initial] = useState(() => valueToString(value));
  const cancelled = useRef(false);
  const numeric = Number(draft);
  const parsed =
    draft.trim() === "" ? null : Number.isFinite(numeric) ? numeric : undefined;
  const display = column.display ?? "number";

  return (
    <div className="flex w-full flex-col gap-1">
      <Input
        autoFocus
        type="number"
        value={draft}
        aria-invalid={invalid || parsed === undefined || undefined}
        className="h-7"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const nextNumber = Number(next);
          const nextParsed =
            next.trim() === ""
              ? null
              : Number.isFinite(nextNumber)
                ? nextNumber
                : undefined;
          if (next !== initial) {
            onDraftCommit(
              nextParsed !== undefined ? nextParsed : parseNumberDraft(initial),
            );
          }
        }}
        onBlur={() => {
          if (!cancelled.current && parsed !== undefined) onFinalCommit(parsed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelled.current = true;
            onCancel(parseNumberDraft(initial));
          }
        }}
      />
      {display === "bar" || display === "ring" ? (
        <NumberPreview column={column} value={Number(parsed ?? 0)} />
      ) : null}
    </div>
  );
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
  onOpenFullPage,
  onOpenNested,
}: {
  row: CollectionTableRow;
  expandable: boolean;
  expanded: boolean;
  nested: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onOpenFullPage: () => void;
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
        onDoubleClick={(event) => {
          event.stopPropagation();
          onOpenFullPage();
        }}
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

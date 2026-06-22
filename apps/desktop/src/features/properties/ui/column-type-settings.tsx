import { useEffect, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  GripVertical,
  Link2,
  Plus,
  RefreshCcw,
  Unlink,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  CollectionSchema,
  ColorName,
  Column,
  PropertyOption,
  RelationTwoWayDiagnostics,
  StatusGroup,
} from "../model/types";
import { STATUS_GROUPS } from "../lib/utils";
import { useColumnTypeSettings } from "../hooks/use-column-type-settings";
import { useOptionSettings } from "../hooks/use-option-settings";
import { useRelationSettings } from "../hooks/use-relation-settings";
import { ColorPicker } from "./color-picker";
import {
  PropertySettingsRow,
  PropertySettingsSection,
} from "./property-settings-row";
import * as m from "@/paraglide/messages.js";

function deferStateUpdate(update: () => void) {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) update();
  });
  return () => {
    cancelled = true;
  };
}

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
          checked={Boolean(column.timeByDefault ?? column.time_by_default)}
          onChange={(checked) => void patchColumn({ time_by_default: checked })}
        />
        <ToggleRow
          label={m.property_date_range()}
          checked={Boolean(column.rangeByDefault ?? column.range_by_default)}
          onChange={(checked) =>
            void patchColumn({ range_by_default: checked })
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

function RelationSettingsPane({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
  onPatchColumn,
}: {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  onPatchColumn: (patch: Record<string, unknown>) => void | Promise<void>;
}) {
  const {
    relation,
    options,
    twoWay,
    reverseName,
    setReverseName,
    diagnostics,
    diagnosticsLoading,
    selectedReverse,
    setSelectedReverse,
    repairing,
    patchRelation,
    runRepair,
  } = useRelationSettings({
    column,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
    onPatchColumn,
  });

  return (
    <div className="flex flex-col gap-2 p-3">
      <ColumnSelect
        label={m.property_relation_linked_collection()}
        value={relation}
        options={options}
        onChange={(nextRelation) => patchRelation({ relation: nextRelation })}
      />
      <ToggleRow
        label={m.property_relation_limit_one()}
        checked={column.limit === "one"}
        onChange={(checked) => patchRelation({ limit: checked ? "one" : null })}
      />
      <ToggleRow
        label={m.property_relation_show_related()}
        checked={twoWay}
        onChange={(checked) => {
          const fallback =
            reverseName.trim() || m.property_relation_reverse_default();
          if (checked) setReverseName(fallback);
          patchRelation({ two_way: checked ? fallback : null });
        }}
      />
      {twoWay ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 text-muted-foreground">
            {m.property_relation_reverse_name()}
          </span>
          <Input
            value={reverseName}
            className="h-8 flex-1"
            placeholder={m.property_relation_reverse_default()}
            onChange={(event) => setReverseName(event.target.value)}
            onBlur={() => {
              const next = reverseName.trim();
              if (next) patchRelation({ two_way: next });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
      ) : null}
      {twoWay ? (
        <RelationDiagnosticsPanel
          diagnostics={diagnostics}
          loading={diagnosticsLoading}
          selectedReverse={selectedReverse}
          reverseName={reverseName}
          repairing={repairing}
          onSelectReverse={setSelectedReverse}
          onRepair={runRepair}
        />
      ) : null}
    </div>
  );
}

function RelationDiagnosticsPanel({
  diagnostics,
  loading,
  selectedReverse,
  reverseName,
  repairing,
  onSelectReverse,
  onRepair,
}: {
  diagnostics: RelationTwoWayDiagnostics | null;
  loading: boolean;
  selectedReverse: string;
  reverseName: string;
  repairing: string | null;
  onSelectReverse: (value: string) => void;
  onRepair: (
    strategy:
      | "from_this_side"
      | "from_related_side"
      | "choose_reverse_column"
      | "create_reverse_column"
      | "detach_two_way",
    reverseColumn?: string | null,
  ) => void | Promise<void>;
}) {
  if (loading || !diagnostics) return null;

  const schemaStatus =
    diagnostics.schemaStatus ?? diagnostics.schema_status ?? "not_two_way";
  const reverseColumn =
    diagnostics.reverseColumn ?? diagnostics.reverse_column ?? reverseName;
  const choices =
    diagnostics.compatibleReverseChoices ??
    diagnostics.compatible_reverse_choices ??
    [];
  const drift = diagnostics.drift;
  const missingReverse =
    drift.missingReverseCount ?? drift.missing_reverse_count ?? 0;
  const missingSource =
    drift.missingSourceCount ?? drift.missing_source_count ?? 0;
  const hasSchemaWarning = schemaStatus !== "ok";
  const hasDrift = missingReverse + missingSource > 0;

  if (!hasSchemaWarning && !hasDrift) return null;

  const createName =
    reverseColumn?.trim() ||
    reverseName.trim() ||
    m.property_relation_reverse_default();
  const description = hasSchemaWarning
    ? (diagnostics.schemaMessage ??
      diagnostics.schema_message ??
      schemaWarningDescription(schemaStatus))
    : m.property_relation_drift_counts({
        reverse: String(missingReverse),
        source: String(missingSource),
      });

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {hasSchemaWarning
              ? m.property_relation_schema_warning()
              : m.property_relation_sync_warning()}
          </div>
          <div className="mt-0.5 text-muted-foreground">{description}</div>
        </div>
      </div>

      {hasSchemaWarning && choices.length > 0 ? (
        <div className="mt-2">
          <Select
            value={selectedReverse || choices[0]?.name}
            onValueChange={onSelectReverse}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((choice) => (
                  <SelectItem key={choice.name} value={choice.name}>
                    {choice.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {hasDrift ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={Boolean(repairing)}
              onClick={() => onRepair("from_this_side")}
            >
              <RefreshCcw data-icon="inline-start" />
              {m.property_relation_repair_this_side()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={Boolean(repairing)}
              onClick={() => onRepair("from_related_side")}
            >
              <RefreshCcw data-icon="inline-start" />
              {m.property_relation_repair_related_side()}
            </Button>
          </>
        ) : null}
        {hasSchemaWarning && choices.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={
              Boolean(repairing) || !(selectedReverse || choices[0]?.name)
            }
            onClick={() =>
              onRepair(
                "choose_reverse_column",
                selectedReverse || choices[0]?.name,
              )
            }
          >
            <Link2 data-icon="inline-start" />
            {m.property_relation_choose_reverse()}
          </Button>
        ) : null}
        {schemaStatus === "missing_reverse" ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={Boolean(repairing)}
            onClick={() => onRepair("create_reverse_column", createName)}
          >
            <Wrench data-icon="inline-start" />
            {m.property_relation_create_reverse()}
          </Button>
        ) : null}
        {hasSchemaWarning ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={Boolean(repairing)}
            onClick={() => onRepair("detach_two_way", reverseColumn)}
          >
            <Unlink data-icon="inline-start" />
            {m.property_relation_detach_two_way()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function schemaWarningDescription(
  status: RelationTwoWayDiagnostics["schemaStatus"],
) {
  if (status === "missing_reverse")
    return m.property_relation_missing_reverse();
  if (status === "incompatible_reverse") {
    return m.property_relation_incompatible_reverse();
  }
  return m.property_relation_schema_warning_desc();
}

function OptionsPane({
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
  const {
    options,
    focusedOption,
    clearFocusedOption,
    patchOptions,
    addOption,
    updateOption,
    renameOption,
    removeOption,
  } = useOptionSettings({
    column,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeName = String(active.id);
    const overName = String(over.id);
    const activeIndex = options.findIndex(
      (option) => option.name === activeName,
    );
    if (activeIndex < 0) return;
    if (column.type === "status" && overName.startsWith("status-group:")) {
      const group = overName.replace("status-group:", "") as StatusGroup;
      patchOptions(
        options.map((option) =>
          option.name === activeName ? { ...option, group } : option,
        ),
      );
      return;
    }
    const overIndex = options.findIndex((option) => option.name === overName);
    if (overIndex < 0) return;
    const overGroup = options[overIndex]?.group ?? null;
    const next = arrayMove(options, activeIndex, overIndex).map((option) =>
      column.type === "status" && option.name === activeName
        ? { ...option, group: overGroup }
        : option,
    );
    patchOptions(next);
  };
  if (column.type === "status") {
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={options.map((option) => option.name)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-0.5 p-1">
            {STATUS_GROUPS.map((group) => (
              <StatusGroupDropZone key={group.value} group={group.value}>
                <PropertySettingsSection label={group.label} />
                {options
                  .filter((option) => option.group === group.value)
                  .map((option) => (
                    <OptionRow
                      key={option.name}
                      option={option}
                      autoFocus={focusedOption === option.name}
                      onColor={(color) => updateOption(option, { color })}
                      onRename={(name) => renameOption(option, name)}
                      onDelete={() => removeOption(option)}
                      onSettled={clearFocusedOption}
                    />
                  ))}
                <PropertySettingsRow
                  icon={Plus}
                  label={m.property_action_add_option()}
                  onClick={() => addOption(group.value)}
                />
              </StatusGroupDropZone>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={options.map((option) => option.name)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-0.5 p-1">
          {options.map((option) => (
            <OptionRow
              key={option.name}
              option={option}
              autoFocus={focusedOption === option.name}
              onColor={(color) => updateOption(option, { color })}
              onRename={(name) => renameOption(option, name)}
              onDelete={() => removeOption(option)}
              onSettled={clearFocusedOption}
            />
          ))}
          <PropertySettingsRow
            icon={Plus}
            label={m.property_action_add_option()}
            onClick={() => addOption()}
          />
        </div>
      </SortableContext>
    </DndContext>
  );
}

function OptionRow({
  option,
  autoFocus,
  onColor,
  onRename,
  onDelete,
  onSettled,
}: {
  option: PropertyOption;
  autoFocus?: boolean;
  onColor: (color: ColorName) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSettled?: () => void;
}) {
  const [draft, setDraft] = useState(option.name);
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: option.name });

  useEffect(() => {
    return deferStateUpdate(() => setDraft(option.name));
  }, [option.name]);

  return (
    <div
      ref={setNodeRef}
      className="flex h-8 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent/60"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <button
        type="button"
        className="flex size-[18px] cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent active:cursor-grabbing [&_svg]:size-3.5"
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
      <ColorPicker
        value={option.color ?? "neutral"}
        onChange={onColor}
        compact
      />
      <Input
        autoFocus={autoFocus}
        value={draft}
        className="h-7 min-w-0 flex-1 rounded-md border-transparent bg-transparent px-2 text-[13px] shadow-none hover:bg-background focus-visible:border-border focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/25"
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          if (autoFocus) event.currentTarget.select();
        }}
        onBlur={() => {
          onRename(draft);
          onSettled?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(option.name);
            event.currentTarget.blur();
          }
        }}
      />
      <Button type="button" variant="ghost" size="icon-xs" onClick={onDelete}>
        <X />
      </Button>
    </div>
  );
}

function StatusGroupDropZone({
  group,
  children,
}: {
  group: StatusGroup;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `status-group:${group}` });
  return (
    <div
      ref={setNodeRef}
      className={isOver ? "rounded-md bg-accent/60" : undefined}
    >
      {children}
    </div>
  );
}

function NumberSettingsPane({
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

function ColumnSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ColumnSelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-20 text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => {
              const normalized = normalizeColumnSelectOption(option);
              return (
                <SelectItem key={normalized.value} value={normalized.value}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{normalized.label}</span>
                    {normalized.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {normalized.description}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
}

type ColumnSelectOption =
  | string
  | {
      value: string;
      label: string;
      description?: string | null;
    };

function normalizeColumnSelectOption(option: ColumnSelectOption) {
  if (typeof option === "string") {
    return { value: option, label: option, description: null };
  }
  return option;
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function nullableNumber(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

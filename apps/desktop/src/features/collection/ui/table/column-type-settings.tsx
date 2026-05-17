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
import { invoke } from "@tauri-apps/api/core";
import { GripVertical, Plus, X } from "lucide-react";
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
  StatusGroup,
} from "@/features/properties/model";
import { STATUS_GROUPS } from "@/features/properties/lib";
import { SettingsRow, SettingsSection } from "../settings-row";
import { ColorPicker } from "./color-picker";
import * as m from "@/paraglide/messages.js";

export function TypeSettingsPane({
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
  onPatchColumn: (patch: Record<string, unknown>) => void;
}) {
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
    return <NumberSettingsPane column={column} onPatchColumn={onPatchColumn} />;
  }
  if (column.type === "date") {
    return (
      <div className="flex flex-col gap-2 p-3">
        <ColumnSelect
          label={m.table_number_display()}
          value={String(column.display ?? "medium")}
          options={["short", "medium", "long"]}
          onChange={(display) => onPatchColumn({ display })}
        />
        <ToggleRow
          label={m.property_date_time()}
          checked={Boolean(column.timeByDefault ?? column.time_by_default)}
          onChange={(checked) => onPatchColumn({ time_by_default: checked })}
        />
        <ToggleRow
          label={m.property_date_range()}
          checked={Boolean(column.rangeByDefault ?? column.range_by_default)}
          onChange={(checked) => onPatchColumn({ range_by_default: checked })}
        />
      </div>
    );
  }
  if (column.type === "person") {
    return (
      <div className="flex flex-col gap-2 p-3">
        <ColumnSelect
          label={m.table_person_source()}
          value={column.display === "all_time" ? "all_time" : "team"}
          options={["team", "all_time"]}
          onChange={(source) =>
            onPatchColumn({
              display: source === "all_time" ? "all_time" : null,
            })
          }
        />
      </div>
    );
  }
  return null;
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
  const options = column.options ?? [];
  const [focusedOption, setFocusedOption] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const patchOptions = (nextOptions: PropertyOption[]) => {
    void invoke<CollectionSchema>("update_schema_column", {
      space: spacePath,
      collectionPath,
      columnName: column.name,
      patch: { options: nextOptions },
      projectPath: projectPath ?? null,
    }).then(onSchemaChange);
  };
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
  const addOption = (group?: StatusGroup) => {
    const name = uniqueOptionName(column.options ?? [], "Option");
    setFocusedOption(name);
    void invoke<CollectionSchema>("add_option", {
      space: spacePath,
      collectionPath,
      columnName: column.name,
      option: { name, color: "neutral", group: group ?? null },
      projectPath: projectPath ?? null,
    }).then(onSchemaChange);
  };
  const updateOption = (
    option: PropertyOption,
    patch: Record<string, unknown>,
  ) => {
    void invoke<CollectionSchema>("update_option", {
      space: spacePath,
      collectionPath,
      columnName: column.name,
      optionName: option.name,
      option: null,
      patch,
      projectPath: projectPath ?? null,
    }).then(onSchemaChange);
  };
  const renameOption = (option: PropertyOption, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === option.name) return;
    void invoke<CollectionSchema>("rename_option", {
      space: spacePath,
      collectionPath,
      columnName: column.name,
      oldOptionName: option.name,
      newOptionName: trimmed,
      projectPath: projectPath ?? null,
    }).then(onSchemaChange);
  };
  const removeOption = (option: PropertyOption) => {
    void invoke<CollectionSchema>("delete_option", {
      space: spacePath,
      collectionPath,
      columnName: column.name,
      optionName: option.name,
      deleteValues: false,
      projectPath: projectPath ?? null,
    }).then(onSchemaChange);
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
                <SettingsSection label={group.label} />
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
                      onSettled={() => setFocusedOption(null)}
                    />
                  ))}
                <SettingsRow
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
              onSettled={() => setFocusedOption(null)}
            />
          ))}
          <SettingsRow
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
  const sortable = useSortable({ id: option.name });

  useEffect(() => {
    setDraft(option.name);
  }, [option.name]);

  return (
    <div
      ref={sortable.setNodeRef}
      className="flex h-8 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent/60"
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <button
        type="button"
        className="flex size-[18px] cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent active:cursor-grabbing [&_svg]:size-3.5"
        {...sortable.attributes}
        {...sortable.listeners}
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
  const droppable = useDroppable({ id: `status-group:${group}` });
  return (
    <div
      ref={droppable.setNodeRef}
      className={droppable.isOver ? "rounded-md bg-accent/60" : undefined}
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
    setMin(column.min == null ? "" : String(column.min));
    setMax(column.max == null ? "" : String(column.max));
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
  options: string[];
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
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </label>
  );
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

function uniqueOptionName(options: PropertyOption[], baseName: string) {
  const names = new Set(options.map((option) => option.name));
  if (!names.has(baseName)) return baseName;
  let index = 2;
  while (names.has(`${baseName} ${index}`)) index += 1;
  return `${baseName} ${index}`;
}

function nullableNumber(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

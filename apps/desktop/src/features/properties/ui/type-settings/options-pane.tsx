import { useEffect, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
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
import { GripVertical, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  CollectionSchema,
  ColorName,
  Column,
  PropertyOption,
  StatusGroup,
} from "../../model/types";
import { STATUS_GROUPS } from "../../lib/utils";
import { useOptionSettings } from "../../hooks/use-option-settings";
import { ColorPicker } from "../color-picker";
import {
  PropertySettingsRow,
  PropertySettingsSection,
} from "../property-settings-row";
import { deferStateUpdate } from "./common";
import * as m from "@/paraglide/messages.js";

export function OptionsPane({
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

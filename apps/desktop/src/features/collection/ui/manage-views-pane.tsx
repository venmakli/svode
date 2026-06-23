import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
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
import { Check, GripVertical, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import type {
  CollectionView,
  ViewType,
} from "@/features/collection/query/model";
import { handleError } from "../lib/errors";
import { viewType } from "../lib/utils";
import { SettingsSection } from "./settings-row";
import { viewIcons } from "./view-icons";
import * as m from "@/paraglide/messages.js";

interface ManageViewsPaneProps {
  activeViewName: string | null;
  views: CollectionView[];
  onReorderViews: (nextOrder: string[]) => Promise<void>;
  onSelectView: (viewName: string) => void;
}

interface ViewRowModel {
  Icon: LucideIcon;
  active: boolean;
  label: string;
  typeLabel: string;
  value: string;
}

export function ManageViewsPane({
  activeViewName,
  views,
  onReorderViews,
  onSelectView,
}: ManageViewsPaneProps) {
  const viewNames = useMemo(() => views.map((view) => view.name), [views]);
  const [orderedNames, setOrderedNames] = useState(viewNames);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    setOrderedNames(viewNames);
  }, [viewNames]);

  const rows = useMemo(() => {
    const byName = new Map(views.map((view) => [view.name, view]));
    return orderedNames
      .map((name) => {
        const view = byName.get(name);
        if (!view) return null;
        const type = viewType(view);
        return {
          Icon: viewIcons[type],
          active: view.name === activeViewName,
          label: view.name,
          typeLabel: viewTypeLabel(type),
          value: view.name,
        };
      })
      .filter((row): row is ViewRowModel => row !== null);
  }, [activeViewName, orderedNames, views]);

  async function handleDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const oldIndex = orderedNames.indexOf(activeId);
    const newIndex = orderedNames.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const previousOrder = orderedNames;
    const nextOrder = arrayMove(orderedNames, oldIndex, newIndex);
    setOrderedNames(nextOrder);
    try {
      await onReorderViews(nextOrder);
    } catch (error) {
      setOrderedNames(previousOrder);
      handleError(error);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="m-2 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {m.collection_no_views()}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={orderedNames}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col p-1">
          <SettingsSection label={m.collection_views_section()} />
          {rows.map((row) => (
            <SortableViewRow
              key={row.value}
              row={row}
              onSelect={() => onSelectView(row.value)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableViewRow({
  row,
  onSelect,
}: {
  row: ViewRowModel;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.value });
  const Icon = row.Icon;

  return (
    <div
      ref={setNodeRef}
      className={cn("flex items-center", isDragging && "opacity-50")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        aria-label={row.label}
        className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
      <Button
        type="button"
        variant="ghost"
        size="default"
        className={cn(
          "min-h-8 min-w-0 flex-1 justify-start gap-2 rounded-md px-2 py-1.5 text-[13px] font-normal",
          "[&_svg:not([class*='size-'])]:size-3.5",
          row.active && "bg-accent text-accent-foreground",
        )}
        onClick={onSelect}
      >
        <Icon
          className={cn(
            "text-muted-foreground",
            row.active && "text-accent-foreground",
          )}
          data-icon="inline-start"
        />
        <span className="truncate font-medium">{row.label}</span>
        <span
          className={cn(
            "ml-auto shrink-0 text-[11.5px] text-muted-foreground",
            row.active && "text-accent-foreground/70",
          )}
        >
          {row.typeLabel}
        </span>
        {row.active ? <Check data-icon="inline-end" /> : null}
      </Button>
    </div>
  );
}

function viewTypeLabel(type: ViewType) {
  const labels: Record<ViewType, string> = {
    table: m.collection_view_type_table(),
    board: m.collection_view_type_board(),
    calendar: m.collection_view_type_calendar(),
    list: m.collection_view_type_list(),
    gallery: m.collection_view_type_gallery(),
  };
  return labels[type];
}

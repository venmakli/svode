import {
  Calendar,
  Check,
  Columns3,
  Eye,
  EyeOff,
  FileText,
  GripVertical,
  LayoutGrid,
  List,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import type { CollectionView, ViewType } from "@/features/collection/query";
import type { CollectionSchema } from "@/features/properties/model";
import { SettingsRow } from "./settings-row";
import { viewIcons } from "./view-icons";
import * as m from "@/paraglide/messages.js";

export function viewTypeLabel(type: ViewType) {
  const labels: Record<ViewType, string> = {
    table: m.collection_view_type_table(),
    board: m.collection_view_type_board(),
    calendar: m.collection_view_type_calendar(),
    list: m.collection_view_type_list(),
    gallery: m.collection_view_type_gallery(),
  };
  return labels[type];
}

export function FieldVisibilityRow({
  icon: Icon,
  label,
  meta,
  visible,
  locked,
  onClick,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  visible: boolean;
  locked?: boolean;
  onClick: () => void;
  onToggle?: () => void;
}) {
  const EyeIcon = visible ? Eye : EyeOff;
  return (
    <SettingsRow
      icon={Icon}
      label={label}
      meta={meta}
      onClick={onClick}
      right={
        <button
          type="button"
          className={cn(
            "rounded p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !visible && "text-muted-foreground",
            locked && "opacity-40",
          )}
          disabled={locked}
          onClick={(event) => {
            event.stopPropagation();
            if (!locked) (onToggle ?? onClick)();
          }}
        >
          <EyeIcon />
        </button>
      }
    />
  );
}

export function SortableFieldVisibilityRow({
  id,
  ...props
}: Parameters<typeof FieldVisibilityRow>[0] & { id: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn("flex items-center", isDragging && "opacity-50")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span
        className="flex h-9 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </span>
      <div className="min-w-0 flex-1">
        <FieldVisibilityRow {...props} />
      </div>
    </div>
  );
}

export function TypeSettingsRows({
  type,
  view,
  schema,
  onPatch,
}: {
  type: ViewType;
  view: CollectionView | null;
  schema: CollectionSchema;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  if (type === "table") {
    const density = String(view?.density ?? "default");
    const nextDensity =
      density === "compact"
        ? "default"
        : density === "default"
          ? "spacious"
          : "compact";
    return (
      <>
        <SettingsRow
          icon={Settings}
          label={m.collection_density()}
          meta={density}
          onClick={() => onPatch({ density: nextDensity })}
        />
        <SettingsRow
          icon={FileText}
          label={m.collection_wrap_text()}
          meta={view?.wrap_text ? "On" : "Off"}
          onClick={() => onPatch({ wrap_text: !view?.wrap_text })}
        />
      </>
    );
  }
  if (type === "board") {
    const cardSize = String(view?.card_size ?? "medium");
    const nextCardSize =
      cardSize === "small"
        ? "medium"
        : cardSize === "medium"
          ? "large"
          : "small";
    return (
      <>
        <SettingsRow
          icon={Columns3}
          label={m.collection_card_size()}
          meta={cardSize}
          onClick={() => onPatch({ card_size: nextCardSize })}
        />
        <SettingsRow
          icon={Columns3}
          label={m.collection_show_empty_groups()}
          meta={view?.show_empty_groups ? "On" : "Off"}
          onClick={() =>
            onPatch({ show_empty_groups: !view?.show_empty_groups })
          }
        />
      </>
    );
  }
  if (type === "calendar") {
    const dateColumns = schema.columns.filter(
      (column) => column.type === "date",
    );
    const defaultScope = String(view?.default_scope ?? "month");
    const nextScope =
      defaultScope === "month"
        ? "week"
        : defaultScope === "week"
          ? "day"
          : defaultScope === "day"
            ? "list"
            : "month";
    return (
      <>
        <SettingsRow
          icon={Calendar}
          label={m.collection_date_field()}
          meta={String(view?.date_field ?? dateColumns[0]?.name ?? "-")}
          onClick={() =>
            dateColumns[0] && onPatch({ date_field: dateColumns[0].name })
          }
        />
        <SettingsRow
          icon={Calendar}
          label={m.collection_default_mode()}
          meta={defaultScope}
          onClick={() => onPatch({ default_scope: nextScope })}
        />
      </>
    );
  }
  if (type === "list") {
    return (
      <SettingsRow
        icon={List}
        label={m.collection_density()}
        meta={String(view?.density ?? "comfortable")}
        onClick={() =>
          onPatch({
            density: view?.density === "compact" ? "comfortable" : "compact",
          })
        }
      />
    );
  }
  const gallerySize = String(view?.size ?? "medium");
  const nextGallerySize =
    gallerySize === "small"
      ? "medium"
      : gallerySize === "medium"
        ? "large"
        : "small";
  const coverSources = Array.isArray(view?.card_cover)
    ? (view.card_cover as unknown[]).map(String)
    : ["cover", "icon", "title"];
  const imageSourceFields = schema.columns
    .filter((column) => column.type === "url" || column.type === "text")
    .map((column) => column.name);
  const coverSourceOptions = [
    ["cover", "icon", "title"],
    ["cover"],
    ["icon"],
    ["title"],
    ...imageSourceFields.map((field) => [field]),
    [],
  ];
  const coverOptionIndex = coverSourceOptions.findIndex((option) =>
    sameStringList(option, coverSources),
  );
  const nextCoverSources =
    coverSourceOptions[
      (Math.max(0, coverOptionIndex) + 1) % coverSourceOptions.length
    ];
  const aspect = String(view?.cover_aspect ?? "16/9").replace(":", "/");
  const aspectOptions = ["16/9", "4/3", "1/1", "3/4"];
  const nextAspect =
    aspectOptions[
      (Math.max(0, aspectOptions.indexOf(aspect)) + 1) % aspectOptions.length
    ];
  return (
    <>
      <SettingsRow
        icon={LayoutGrid}
        label={m.collection_card_cover()}
        meta={
          coverSources.length > 0
            ? coverSources.join(", ")
            : m.collection_none()
        }
        onClick={() => onPatch({ card_cover: nextCoverSources })}
      />
      <SettingsRow
        icon={LayoutGrid}
        label={m.collection_cover_fit()}
        meta={String(view?.cover_fit ?? "cover")}
        onClick={() =>
          onPatch({
            cover_fit: view?.cover_fit === "contain" ? "cover" : "contain",
          })
        }
      />
      <SettingsRow
        icon={LayoutGrid}
        label={m.collection_aspect_ratio()}
        meta={aspect}
        onClick={() => onPatch({ cover_aspect: nextAspect })}
      />
      <SettingsRow
        icon={LayoutGrid}
        label={m.collection_card_size()}
        meta={gallerySize}
        onClick={() => onPatch({ size: nextGallerySize })}
      />
    </>
  );
}

function sameStringList(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

export function GroupPane({
  schema,
  activeGroupBy,
  onSelect,
}: {
  schema: CollectionSchema;
  activeGroupBy: string | null;
  onSelect: (field: string) => void;
}) {
  const groupable = schema.columns.filter((column) =>
    ["status", "select", "person"].includes(column.type),
  );
  return (
    <div className="flex flex-col p-1">
      {groupable.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          {m.collection_no_groupable_fields()}
        </div>
      ) : (
        groupable.map((column) => (
          <SettingsRow
            key={column.name}
            icon={Columns3}
            label={column.name}
            meta={activeGroupBy === column.name ? undefined : column.type}
            right={activeGroupBy === column.name ? <Check /> : null}
            onClick={() => onSelect(column.name)}
          />
        ))
      )}
    </div>
  );
}

export function ViewTypeRows({
  type,
  onSelect,
}: {
  type: ViewType;
  onSelect: (nextType: ViewType) => void;
}) {
  return (
    <div className="flex flex-col p-1">
      {(["table", "board", "calendar", "list", "gallery"] as ViewType[]).map(
        (nextType) => {
          const Icon = viewIcons[nextType];
          return (
            <SettingsRow
              key={nextType}
              icon={Icon}
              label={viewTypeLabel(nextType)}
              right={nextType === type ? <Check /> : null}
              onClick={() => onSelect(nextType)}
            />
          );
        },
      )}
    </div>
  );
}

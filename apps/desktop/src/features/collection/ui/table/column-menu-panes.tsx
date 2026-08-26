import { ArrowUpDown, EyeOff, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FILTER_OP_LABELS } from "@/features/collection/query/model";
import type { QueryFilter, QuerySort } from "@/features/collection/query/model";
import {
  SchemaMenuRow,
  SchemaMenuSection,
  SchemaMenuSeparator,
  type SchemaColumnMenuExtensionControls,
} from "@/features/properties/column-menu";
import * as m from "@/paraglide/messages.js";

export function TitleColumnMainPane({
  label,
  filter,
  sort,
  onLabelChange,
  onRename,
  onOpenPane,
}: {
  label: string;
  filter: QueryFilter | null;
  sort: QuerySort | null;
  onLabelChange: (label: string) => void;
  onRename: (label: string | null) => void;
  onOpenPane: (pane: string) => void;
}) {
  return (
    <div className="flex flex-col p-1">
      <div className="p-1">
        <Input
          autoFocus
          value={label}
          aria-label={m.property_dialog_name()}
          className="h-9 border-0 bg-muted px-3 text-sm font-semibold shadow-none focus-visible:ring-0"
          onChange={(event) => onLabelChange(event.target.value)}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (!next) return;
            onRename(next === m.collection_field_title() ? null : next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
      <SchemaMenuSection label={m.table_query_section()} />
      <SchemaMenuRow
        icon={Filter}
        label={m.table_filter()}
        meta={filter ? FILTER_OP_LABELS[filter.op] : m.collection_none()}
        onClick={() => onOpenPane("filter")}
      />
      <SchemaMenuRow
        icon={ArrowUpDown}
        label={m.view_query_sort_title()}
        meta={sort ? sortDirectionLabel(sort) : m.collection_none()}
        onClick={() => onOpenPane("sort")}
      />
    </div>
  );
}

export function TableSchemaMenuExtension({
  field,
  visibleFields,
  filter,
  sort,
  onUpdateViewPatch,
  controls,
}: {
  field: string;
  visibleFields: string[];
  filter: QueryFilter | null;
  sort: QuerySort | null;
  onUpdateViewPatch: (patch: Record<string, unknown>) => Promise<void>;
  controls: SchemaColumnMenuExtensionControls;
}) {
  return (
    <>
      <SchemaMenuRow
        icon={EyeOff}
        label={m.table_hide_column()}
        onClick={() => {
          void onUpdateViewPatch({
            visible_fields: visibleFields.filter(
              (visible) => visible !== field,
            ),
          });
          controls.close();
        }}
      />
      <SchemaMenuSeparator />
      <SchemaMenuSection label={m.table_query_section()} />
      <SchemaMenuRow
        icon={Filter}
        label={m.table_filter()}
        meta={filter ? FILTER_OP_LABELS[filter.op] : m.collection_none()}
        onClick={() => controls.openPane("filter")}
      />
      <SchemaMenuRow
        icon={ArrowUpDown}
        label={m.view_query_sort_title()}
        meta={sort ? sortDirectionLabel(sort) : m.collection_none()}
        onClick={() => controls.openPane("sort")}
      />
    </>
  );
}

function sortDirectionLabel(sort: QuerySort) {
  return sort.desc ? m.view_query_sort_desc() : m.view_query_sort_asc();
}

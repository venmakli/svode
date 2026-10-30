import {
  ArrowUpDown,
  Columns3,
  Copy,
  Filter,
  LayoutGrid,
  Table,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "@/features/collection/query/model";
import type { CollectionSchema } from "@/features/properties";
import type { SettingsPane } from "../../model";
import { handleError } from "../../hooks/error-feedback";
import { viewType } from "../../lib/utils";
import { SettingsRow, SettingsSection } from "@/shared/ui/settings-row";
import {
  TypeSettingsRows,
  ViewTypeRows,
  viewTypeLabel,
} from "../view-settings-panes";
import * as m from "@/paraglide/messages.js";

export function ViewSettingsMainPane({
  view,
  newer,
  renameValue,
  schema,
  query,
  onRenameValueChange,
  onRename,
  openPane,
  updateTypeSetting,
}: {
  view: CollectionView | null;
  newer: boolean;
  renameValue: string;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  onRenameValueChange: (value: string) => void;
  onRename: () => Promise<void>;
  openPane: (pane: SettingsPane) => void;
  updateTypeSetting: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col p-1">
      <div className="p-2">
        <Input
          autoFocus
          value={renameValue}
          onChange={(event) => onRenameValueChange(event.target.value)}
          onBlur={() => void onRename().catch(handleError)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onRename().catch(handleError);
          }}
          className="h-9 border-0 bg-muted px-3 text-sm font-semibold shadow-none focus-visible:ring-0"
        />
      </div>
      {!newer ? (
        <ViewSettingsMainRows
          view={view}
          schema={schema}
          query={query}
          openPane={openPane}
          updateTypeSetting={updateTypeSetting}
        />
      ) : null}
    </div>
  );
}

function ViewSettingsMainRows({
  view,
  schema,
  query,
  openPane,
  updateTypeSetting,
}: {
  view: CollectionView | null;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  openPane: (pane: SettingsPane) => void;
  updateTypeSetting: (patch: Record<string, unknown>) => void;
}) {
  const type = viewType(view);

  return (
    <>
      <SettingsSection label={m.collection_general_section()} />
      <SettingsRow
        icon={LayoutGrid}
        label={m.collection_view_type()}
        meta={viewTypeLabel(type)}
        onClick={() => openPane("layout")}
      />
      <SettingsRow
        icon={Table}
        label={m.collection_properties_label()}
        meta={m.collection_properties_shortcut()}
        onClick={() => openPane("properties")}
      />
      <SettingsRow
        icon={Filter}
        label={m.view_query_filter_title()}
        meta={queryCountLabel(query.merged.filter.length)}
        onClick={() => openPane("filter")}
      />
      <SettingsRow
        icon={ArrowUpDown}
        label={m.view_query_sort_title()}
        meta={queryCountLabel(query.merged.sort.length)}
        onClick={() => openPane("sort")}
      />
      {type === "board" ? (
        <SettingsRow
          icon={Columns3}
          label={m.view_query_group_title()}
          meta={String(
            (view?.group_by ?? view?.groupBy ?? m.collection_none()) as string,
          )}
          onClick={() => openPane("group")}
        />
      ) : null}
      <SettingsSection label={m.collection_view_specific_settings({ type })} />
      <TypeSettingsRows
        type={type}
        view={view}
        schema={schema}
        onPatch={updateTypeSetting}
      />
    </>
  );
}

export function ViewSettingsMainFooter({
  onDuplicate,
  onDeleteRequest,
}: {
  /** `null` when the view cannot be duplicated. */
  onDuplicate: (() => Promise<void>) | null;
  onDeleteRequest: () => void;
}) {
  return (
    <div className="flex flex-col">
      {onDuplicate ? (
        <SettingsRow
          icon={Copy}
          label={m.collection_duplicate_view()}
          right={null}
          onClick={() => void onDuplicate().catch(handleError)}
        />
      ) : null}
      <SettingsRow
        icon={Trash2}
        label={m.space_delete()}
        right={null}
        destructive
        onClick={onDeleteRequest}
      />
    </div>
  );
}

export function ViewSettingsLayoutPane({
  type,
  view,
  autoConfigForType,
  onUpdateView,
}: {
  type: ViewType;
  view: CollectionView | null;
  autoConfigForType: (type: ViewType) => Record<string, unknown>;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
}) {
  return (
    <ViewTypeRows
      type={type}
      onSelect={(nextType) =>
        view &&
        void onUpdateView(view.name, autoConfigForType(nextType)).catch(
          handleError,
        )
      }
    />
  );
}

function queryCountLabel(count: number) {
  return count > 0 ? m.collection_rules_count({ count }) : m.collection_none();
}

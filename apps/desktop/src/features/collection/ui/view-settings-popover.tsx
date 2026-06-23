import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { MultiPanePopover } from "@/features/collection/query/ui";
import type {
  CollectionView,
  UseViewQueryResult,
  ViewType,
} from "@/features/collection/query/model";
import type { CollectionSchema } from "@/features/properties";
import { useCollectionActors, useViewSettingsActions } from "../hooks";
import { viewType } from "../lib/utils";
import type { SettingsPane } from "../model";
import {
  ViewSettingsLayoutPane,
  ViewSettingsMainFooter,
  ViewSettingsMainPane,
} from "./view-settings/main-pane";
import {
  ViewSettingsPropertiesPane,
  ViewSettingsPropertyAddTypePane,
  ViewSettingsPropertyEditPane,
} from "./view-settings/properties-pane";
import {
  ViewSettingsFilterEditorPane,
  ViewSettingsFilterFieldPane,
  ViewSettingsFilterPane,
  ViewSettingsGroupPane,
  ViewSettingsSortEditorPane,
  ViewSettingsSortFieldPane,
  ViewSettingsSortPane,
} from "./view-settings/query-panes";
import * as m from "@/paraglide/messages.js";

const systemFieldIds = ["title", "icon", "description", "created", "updated"];

export function ViewSettingsPopover({
  open,
  pane,
  view,
  renameValue,
  onOpenChange,
  onPaneChange,
  onRenameValueChange,
  onRename,
  onUpdateView,
  onDuplicate,
  onDeleteRequest,
  schema,
  query,
  collectionPath,
  spacePath,
  projectPath,
  onSchemaChange,
  autoConfigForType,
}: {
  open: boolean;
  pane: SettingsPane;
  view: CollectionView | null;
  renameValue: string;
  onOpenChange: (open: boolean) => void;
  onPaneChange: (pane: SettingsPane) => void;
  onRenameValueChange: (value: string) => void;
  onRename: () => Promise<void>;
  onUpdateView: (
    viewName: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  onDuplicate: () => Promise<void>;
  onDeleteRequest: () => void;
  schema: CollectionSchema;
  query: UseViewQueryResult;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  autoConfigForType: (type: ViewType) => Record<string, unknown>;
}) {
  const type = viewType(view);
  const visibleFieldKey = type === "table" ? "visible_fields" : "card_fields";
  const savedFields = (view?.[visibleFieldKey] as string[] | undefined) ?? [
    "title",
    ...schema.columns.map((column) => column.name),
  ];
  const { actors: queryActors, loadActors: loadQueryActors } =
    useCollectionActors(spacePath);
  const {
    addColumn,
    addColumnWithType,
    addFilterRule,
    addSortRule,
    applyFilterDraft,
    applySortDraft,
    clearFilterDraft,
    clearSortDraft,
    customFieldIds,
    filterDraft,
    openExistingFilter,
    openExistingSort,
    openFieldFilter,
    openFieldSort,
    openNewFilter,
    openNewSort,
    openPane,
    openProperty,
    reorderFields,
    selectedProperty,
    setPane,
    sortDraft,
    toggleField,
    updateFilterDraft,
    updateSortDraft,
    updateTypeSetting,
  } = useViewSettingsActions({
    view,
    schema,
    query,
    collectionPath,
    spacePath,
    projectPath,
    savedFields,
    visibleFieldKey,
    systemFieldIds,
    onOpenChange,
    onPaneChange,
    onUpdateView,
    onSchemaChange,
  });
  const filterPane = ViewSettingsFilterPane({
    schema,
    query,
    addFilterRule,
    openExistingFilter,
  });
  const filterEditorPane = ViewSettingsFilterEditorPane({
    schema,
    query,
    filterDraft,
    queryActors,
    loadQueryActors,
    updateFilterDraft,
    applyFilterDraft,
    clearFilterDraft,
    onSchemaChange,
  });
  const sortPane = ViewSettingsSortPane({
    schema,
    query,
    addSortRule,
    openExistingSort,
  });
  const sortEditorPane = ViewSettingsSortEditorPane({
    query,
    sortDraft,
    updateSortDraft,
    applySortDraft,
    clearSortDraft,
    onSchemaChange,
  });
  const groupPane = ViewSettingsGroupPane({
    schema,
    query,
    onSchemaChange,
  });

  const panes = [
    {
      id: "main" as const,
      title: view?.name ?? m.collection_view(),
      content: (
        <ViewSettingsMainPane
          view={view}
          renameValue={renameValue}
          schema={schema}
          query={query}
          onRenameValueChange={onRenameValueChange}
          onRename={onRename}
          openPane={openPane}
          updateTypeSetting={updateTypeSetting}
        />
      ),
      footer: (
        <ViewSettingsMainFooter
          onDuplicate={onDuplicate}
          onDeleteRequest={onDeleteRequest}
        />
      ),
    },
    {
      id: "layout" as const,
      title: m.collection_view_type(),
      content: (
        <ViewSettingsLayoutPane
          type={type}
          view={view}
          autoConfigForType={autoConfigForType}
          onUpdateView={onUpdateView}
        />
      ),
      notice: m.collection_view_type_notice(),
    },
    {
      id: "properties" as const,
      title: m.collection_properties_label(),
      content: (
        <ViewSettingsPropertiesPane
          type={type}
          schema={schema}
          savedFields={savedFields}
          systemFieldIds={systemFieldIds}
          customFieldIds={customFieldIds}
          reorderFields={reorderFields}
          addColumn={addColumn}
          openProperty={openProperty}
          toggleField={toggleField}
        />
      ),
      notice: m.collection_properties_notice(),
    },
    {
      id: "propertyAddType" as const,
      title: m.table_property_type_title(),
      content: (
        <ViewSettingsPropertyAddTypePane
          addColumnWithType={addColumnWithType}
        />
      ),
      notice: m.table_property_type_notice(),
    },
    {
      id: "propertyEdit" as const,
      title: selectedProperty,
      content: (
        <ViewSettingsPropertyEditPane
          selectedProperty={selectedProperty}
          savedFields={savedFields}
          schema={schema}
          query={query}
          toggleField={toggleField}
          openFieldFilter={openFieldFilter}
          openFieldSort={openFieldSort}
        />
      ),
    },
    {
      id: "filter" as const,
      title: m.view_query_filter_title(),
      content: filterPane.content,
      footer: filterPane.footer,
      footerSeparator: false,
    },
    {
      id: "filterField" as const,
      title: m.view_query_choose_property(),
      content: (
        <ViewSettingsFilterFieldPane
          schema={schema}
          openNewFilter={openNewFilter}
        />
      ),
    },
    {
      id: "filterEditor" as const,
      title: filterDraft
        ? m.view_query_filter_editor_title({ field: filterDraft.filter.field })
        : m.view_query_filter_title(),
      content: filterEditorPane.content,
      footer: filterEditorPane.footer,
    },
    {
      id: "sort" as const,
      title: m.view_query_sort_title(),
      content: sortPane.content,
      footer: sortPane.footer,
      footerSeparator: false,
    },
    {
      id: "sortField" as const,
      title: m.view_query_choose_property(),
      content: (
        <ViewSettingsSortFieldPane schema={schema} openNewSort={openNewSort} />
      ),
    },
    {
      id: "sortEditor" as const,
      title: sortDraft
        ? m.view_query_sort_editor_title({ field: sortDraft.sort.field })
        : m.view_query_sort_title(),
      content: sortEditorPane.content,
      footer: sortEditorPane.footer,
    },
    {
      id: "group" as const,
      title: m.view_query_group_title(),
      content: groupPane.content,
      footer: groupPane.footer,
    },
  ];

  return (
    <MultiPanePopover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setPane("main");
        onOpenChange(nextOpen);
      }}
      pane={pane}
      onPaneChange={setPane}
      mainPane="main"
      className="w-80 max-w-[calc(100vw-2rem)]"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground",
            open &&
              pane === "main" &&
              "bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
          )}
        >
          <Settings />
          <span className="sr-only">{m.view_query_settings_title()}</span>
        </Button>
      }
      panes={panes}
    />
  );
}

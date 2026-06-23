import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Database } from "lucide-react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { EntryIdentityHeader } from "@/features/editor";
import { TitleZone } from "@/features/editor";
import { PlateDocumentEditor } from "@/features/editor";
import { PropertyPanel } from "@/features/properties/panel";
import { normalizeSchema } from "@/features/properties";
import {
  detailPageHeaderClassName,
  detailPageToolbarClassName,
} from "@/shared/ui/page-layout";
import { useOpenEntryDocument } from "@/features/entry/selection";
import type { Entry } from "@/features/entry";
import { useSpaceTreeSync } from "@/features/space";
import { useViewQuery } from "@/features/collection/query";
import { DeleteDialogs } from "./delete-dialogs";
import { EntryDetailActions } from "./entry-detail-actions";
import { EntrySystemFields } from "./entry-system-fields";
import { DocumentSettings } from "./document-settings-popover";
import { EntryPeekSheet } from "./entry-peek-sheet";
import { handleError } from "../lib/errors";
import { propertyFieldSavePolicy } from "../model/property-field-save-policy";
import { CollectionSkeleton } from "./skeleton";
import { CollectionTabStrip } from "./view-tabs";
import { ViewPlaceholder } from "./view-placeholder";
import { BoardView } from "./board/board-view";
import { CalendarView } from "./calendar/calendar-view";
import { GalleryView } from "./gallery/gallery-view";
import { ListView } from "./list/list-view";
import { TableView } from "./table/table-view";
import { ViewActionBar } from "./view-action-bar";
import {
  useCollectionEntryActions,
  useCollectionSchemaState,
  useCollectionTemplates,
  useCollectionViewActions,
} from "../hooks";
import {
  collectionPathFor,
  humanize,
  isEditableTarget,
  readmePathFor,
  viewName,
  viewType,
} from "../lib/utils";
import type { ActiveTab, EntryPeekTarget, SettingsPane } from "../model";
import type { CollectionView } from "@/features/collection/query";
import * as m from "@/paraglide/messages.js";

interface CollectionScreenProps {
  spacePath: string;
  projectPath?: string | null;
  documentPath: string;
  spaceId: string;
  hasReadme: boolean;
  headerActions?: ReactNode;
}

export function CollectionScreen({
  spacePath,
  projectPath,
  documentPath,
  spaceId,
  hasReadme,
  headerActions,
}: CollectionScreenProps) {
  const collectionPath = useMemo(
    () => collectionPathFor(documentPath),
    [documentPath],
  );
  const readmePath = readmePathFor(collectionPath);
  const openDocument = useOpenEntryDocument();
  const openPath = useCallback(
    (path: string) => openDocument(path, spaceId),
    [openDocument, spaceId],
  );
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
  );
  const {
    schema,
    setSchema,
    entry,
    setEntry,
    propertiesSchema,
    loading,
    schemaError,
    documentLabel,
    setDocumentLabel,
    updateReadmeField,
    createReadmeForIdentity,
    updateIdentity,
    updateCover,
    saveDocumentLabel,
  } = useCollectionSchemaState({
    spacePath,
    projectPath,
    collectionPath,
    readmePath,
    spaceId,
    hasReadme,
    openDocument,
  });
  const [activeTab, setActiveTab] = useState<ActiveTab>("document");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("main");
  const [renameValue, setRenameValue] = useState("");
  const [documentLabelOpen, setDocumentLabelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [peekTarget, setPeekTarget] = useState<EntryPeekTarget | null>(null);
  const [tableCreateRequest, setTableCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const [boardCreateRequest, setBoardCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const [calendarCreateRequest, setCalendarCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const [listCreateRequest, setListCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const [galleryCreateRequest, setGalleryCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const initializedCollectionRef = useRef<string | null>(null);
  const {
    deleteEntry,
    setDeleteEntry,
    entriesVersion,
    refreshEntries,
    createEntry,
    duplicateRow,
    deleteRow,
    duplicateDetailEntry,
  } = useCollectionEntryActions({
    schema,
    spacePath,
    projectPath,
    collectionPath,
    spaceId,
    openDocument,
  });

  const views = useMemo(
    () =>
      ((schema?.views ?? []) as CollectionView[]).filter((view) =>
        viewName(view),
      ),
    [schema],
  );
  const activeView = views.find((view) => view.name === activeTab) ?? null;
  const query = useViewQuery({
    spacePath,
    projectPath,
    collectionPath,
    viewName: activeView?.name ?? "",
    schema: schema ?? { columns: [], views: [] },
    view: activeView,
  });

  const selectTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    const url = new URL(window.location.href);
    if (next === "document") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  useEffect(() => {
    if (!schema) return;
    const key = `${collectionPath}:${hasReadme ? "readme" : "no-readme"}`;
    if (initializedCollectionRef.current === key) {
      if (
        activeTab !== "document" &&
        !views.some((view) => view.name === activeTab)
      ) {
        queueMicrotask(() =>
          selectTab(hasReadme ? "document" : (views[0]?.name ?? "document")),
        );
      }
      return;
    }
    initializedCollectionRef.current = key;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view");
    if (requested && views.some((view) => view.name === requested)) {
      queueMicrotask(() => selectTab(requested));
      return;
    }
    if (hasReadme) {
      queueMicrotask(() => selectTab("document"));
      return;
    }
    queueMicrotask(() => selectTab(views[0]?.name ?? "document"));
  }, [activeTab, collectionPath, hasReadme, schema, selectTab, views]);

  useEffect(() => {
    queueMicrotask(() => {
      setSearchOpen(false);
      setSearchQuery("");
      setSettingsOpen(false);
      setDocumentLabelOpen(false);
    });
  }, [activeTab]);

  useEffect(() => {
    if (!activeView) return;
    queueMicrotask(() => setRenameValue(activeView.name));
  }, [activeView]);

  const {
    addView,
    autoConfigForType,
    updateView,
    renameActiveView,
    duplicateActiveView,
    deleteActiveView,
    reorder,
    moveActive,
  } = useCollectionViewActions({
    schema,
    setSchema,
    views,
    activeView,
    renameValue,
    collectionPath,
    spacePath,
    projectPath,
    hasReadme,
    selectTab,
    setSettingsPane,
    setSettingsOpen,
    setDeleteOpen,
  });
  const {
    loadTemplatesForMenu,
    createTemplateForMenu,
    instantiateTemplateForMenu,
    editTemplate,
    setDefaultTemplateForMenu,
    duplicateTemplateForMenu,
    deleteTemplateForMenu,
    reorderTemplatesForMenu,
    duplicateTemplateEntry,
  } = useCollectionTemplates({
    schema,
    setSchema,
    setPeekTarget,
    refreshEntries,
    spacePath,
    projectPath,
    collectionPath,
    spaceId,
    openDocument,
  });

  function focusTableCreate(asFolder: boolean) {
    setTableCreateRequest((request) => ({
      signal: request.signal + 1,
      asFolder,
    }));
  }

  function focusBoardCreate(asFolder: boolean) {
    setBoardCreateRequest((request) => ({
      signal: request.signal + 1,
      asFolder,
    }));
  }

  function focusCalendarCreate(asFolder: boolean) {
    setCalendarCreateRequest((request) => ({
      signal: request.signal + 1,
      asFolder,
    }));
  }

  function focusListCreate(asFolder: boolean) {
    setListCreateRequest((request) => ({
      signal: request.signal + 1,
      asFolder,
    }));
  }

  function focusGalleryCreate(asFolder: boolean) {
    setGalleryCreateRequest((request) => ({
      signal: request.signal + 1,
      asFolder,
    }));
  }

  function openPeek(entryToOpen: Entry, nested = false) {
    setPeekTarget({ entry: entryToOpen, nested });
  }

  function openFullPage(entryToOpen: Entry) {
    setPeekTarget(null);
    openDocument(entryToOpen.path, spaceId);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        void moveActive(1).catch(handleError);
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void moveActive(-1).catch(handleError);
        return;
      }
      if (!event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        const tabs = [
          hasReadme ? "document" : null,
          ...views.map((view) => view.name),
        ].filter(Boolean) as string[];
        const index = tabs.indexOf(activeTab);
        selectTab(tabs[Math.min(tabs.length - 1, index + 1)] ?? activeTab);
        return;
      }
      if (!event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        const tabs = [
          hasReadme ? "document" : null,
          ...views.map((view) => view.name),
        ].filter(Boolean) as string[];
        const index = tabs.indexOf(activeTab);
        selectTab(tabs[Math.max(0, index - 1)] ?? activeTab);
        return;
      }
      const numeric = Number(event.key);
      if (numeric >= 1 && numeric <= 9) {
        const tabs = [
          hasReadme ? "document" : null,
          ...views.map((view) => view.name),
        ].filter(Boolean) as string[];
        const next = tabs[numeric - 1];
        if (next) {
          event.preventDefault();
          selectTab(next);
        }
        return;
      }
      if (!event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (activeView && viewType(activeView) === "table") {
          focusTableCreate(false);
          return;
        }
        if (activeView && viewType(activeView) === "board") {
          focusBoardCreate(false);
          return;
        }
        if (activeView && viewType(activeView) === "calendar") {
          focusCalendarCreate(false);
          return;
        }
        if (activeView && viewType(activeView) === "list") {
          focusListCreate(false);
          return;
        }
        if (activeView && viewType(activeView) === "gallery") {
          focusGalleryCreate(false);
          return;
        }
        void createEntry(false).catch(handleError);
        return;
      }
      if (event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (activeView && viewType(activeView) === "table") {
          focusTableCreate(true);
          return;
        }
        if (activeView && viewType(activeView) === "board") {
          focusBoardCreate(true);
          return;
        }
        if (activeView && viewType(activeView) === "calendar") {
          focusCalendarCreate(true);
          return;
        }
        if (activeView && viewType(activeView) === "list") {
          focusListCreate(true);
          return;
        }
        if (activeView && viewType(activeView) === "gallery") {
          focusGalleryCreate(true);
          return;
        }
        void createEntry(true).catch(handleError);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const hasHeaderProperties = Boolean(
    propertiesSchema && propertiesSchema.schema.columns.length > 0 && entry,
  );

  if (loading) {
    return <CollectionSkeleton />;
  }

  if (schemaError || !schema) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <div className="font-medium">{m.collection_invalid_schema()}</div>
          <div className="mt-1 text-muted-foreground">{schemaError}</div>
        </div>
      </div>
    );
  }

  const title = entry?.meta.title ?? humanize(collectionPath);
  const icon = entry?.meta.icon ?? null;
  const description = entry?.meta.description ?? "";
  const cover = entry?.meta.cover ?? null;
  const documentLabelValue =
    schema.document?.label || m.collection_document_tab();
  const effectiveHeaderActions =
    headerActions ??
    (entry ? (
      <EntryDetailActions
        entry={entry}
        spacePath={spacePath}
        projectPath={projectPath}
        spaceId={spaceId}
        onConverted={(nextEntry, nested) => {
          setEntry(nextEntry);
          openDocument(nextEntry.path, spaceId);
          if (nested) void reloadTreePathParents(spaceId, [nextEntry.path]);
        }}
        onDuplicateEntry={(entryToDuplicate) =>
          void duplicateDetailEntry(entryToDuplicate).catch(handleError)
        }
        onDeleteEntry={setDeleteEntry}
      />
    ) : null);

  return (
    <div className="flex min-h-full flex-col">
      <div className={detailPageHeaderClassName}>
        <div>
          {hasReadme ? (
            <EntryIdentityHeader
              title={title}
              icon={icon}
              description={description}
              cover={cover}
              projectPath={projectPath ?? null}
              spacePath={spacePath}
              documentPath={readmePath}
              onTitleChange={(value) =>
                void updateIdentity("title", value).catch(handleError)
              }
              onIconChange={(value) =>
                void updateIdentity("icon", value).catch(handleError)
              }
              onDescriptionChange={(value) =>
                void updateIdentity("description", value).catch(handleError)
              }
              onCoverChange={(nextCover) =>
                void updateCover(nextCover).catch(handleError)
              }
              onBodyFocus={() => selectTab("document")}
              titleClassName={
                effectiveHeaderActions ? "max-w-none" : "max-w-4xl"
              }
              actions={effectiveHeaderActions}
              metadata={entry ? <EntrySystemFields meta={entry.meta} /> : null}
              coverSize={effectiveHeaderActions ? "compact" : "default"}
            />
          ) : (
            <div className="max-w-4xl">
              <TitleZone
                title={title}
                icon={null}
                description=""
                readOnly
                hideDescription
                fallbackIcon={Database}
                onActivateIdentity={() =>
                  void createReadmeForIdentity().catch(handleError)
                }
                onTitleChange={() =>
                  void createReadmeForIdentity().catch(handleError)
                }
                onIconChange={() =>
                  void createReadmeForIdentity().catch(handleError)
                }
                onDescriptionChange={() => undefined}
                onBodyFocus={() => undefined}
              />
            </div>
          )}
        </div>
        {hasHeaderProperties && entry && propertiesSchema ? (
          <div className="max-w-5xl">
            <PropertyPanel
              spacePath={spacePath}
              projectPath={projectPath}
              spaceId={spaceId}
              filePath={readmePath}
              schemaResult={propertiesSchema}
              values={entry.meta.extra ?? {}}
              mode="full"
              onOpenPath={openPath}
              onValueChange={async (field, value) => {
                const column = propertiesSchema.schema.columns.find(
                  (item) => item.name === field,
                );
                await updateReadmeField(entry, field, value, {
                  policy: column ? propertyFieldSavePolicy(column) : undefined,
                });
              }}
            />
          </div>
        ) : null}
      </div>

      <Tabs value={activeTab} onValueChange={selectTab} className="gap-0">
        <div className={detailPageToolbarClassName}>
          <CollectionTabStrip
            activeTab={activeTab}
            addViewOptions={[
              { type: "table", label: m.collection_view_type_table() },
              { type: "board", label: m.collection_view_type_board() },
              { type: "calendar", label: m.collection_view_type_calendar() },
              { type: "list", label: m.collection_view_type_list() },
              { type: "gallery", label: m.collection_view_type_gallery() },
            ]}
            addViewLabel={m.collection_add_view()}
            documentLabel={documentLabelValue}
            hasReadme={hasReadme}
            manageViewsLabel={m.collection_manage_views()}
            moreViewsLabel={m.collection_more_views()}
            views={views}
            onAddView={(type) => void addView(type).catch(handleError)}
            onReorderViews={reorder}
            onTabChange={selectTab}
          />
          {activeTab === "document" ? (
            <DocumentSettings
              open={documentLabelOpen}
              label={documentLabel}
              onOpenChange={setDocumentLabelOpen}
              onLabelChange={setDocumentLabel}
              onSave={() => void saveDocumentLabel().catch(handleError)}
            />
          ) : (
            <ViewActionBar
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              settingsOpen={settingsOpen}
              settingsPane={settingsPane}
              activeView={activeView}
              renameValue={renameValue}
              schema={schema}
              query={query}
              collectionPath={collectionPath}
              spacePath={spacePath}
              projectPath={projectPath}
              onSearchOpenChange={setSearchOpen}
              onSearchQueryChange={setSearchQuery}
              onSettingsOpenChange={setSettingsOpen}
              onSettingsPaneChange={setSettingsPane}
              onRenameValueChange={setRenameValue}
              onRename={renameActiveView}
              onUpdateView={updateView}
              onDuplicateView={duplicateActiveView}
              onDeleteViewRequest={() => setDeleteOpen(true)}
              onSchemaChange={(nextSchema) =>
                setSchema(normalizeSchema(nextSchema))
              }
              autoConfigForType={autoConfigForType}
              onLoadTemplates={loadTemplatesForMenu}
              onCreateTemplate={createTemplateForMenu}
              onInstantiateTemplate={instantiateTemplateForMenu}
              onEditTemplate={editTemplate}
              onSetDefaultTemplate={setDefaultTemplateForMenu}
              onDuplicateTemplate={duplicateTemplateForMenu}
              onDeleteTemplate={deleteTemplateForMenu}
              onReorderTemplates={reorderTemplatesForMenu}
              onCreateEntry={(asFolder) => {
                if (activeView && viewType(activeView) === "table") {
                  focusTableCreate(asFolder);
                  return;
                }
                if (activeView && viewType(activeView) === "board") {
                  focusBoardCreate(asFolder);
                  return;
                }
                if (activeView && viewType(activeView) === "calendar") {
                  focusCalendarCreate(asFolder);
                  return;
                }
                if (activeView && viewType(activeView) === "list") {
                  focusListCreate(asFolder);
                  return;
                }
                if (activeView && viewType(activeView) === "gallery") {
                  focusGalleryCreate(asFolder);
                  return;
                }
                void createEntry(asFolder).catch(handleError);
              }}
            />
          )}
        </div>

        {hasReadme ? (
          <TabsContent value="document" className="flex-none">
            <PlateDocumentEditor
              bodyOnly
              pageScroll
              documentPath={readmePath}
              documentSpaceId={spaceId}
              spacePath={spacePath}
              projectPath={projectPath}
              bodyOnlyMeta={entry?.meta ?? null}
              initialEntry={entry}
              initialEntrySpacePath={spacePath}
              onDocumentPathChange={(path) => {
                setEntry((current) =>
                  current ? { ...current, path } : current,
                );
                openDocument(path, spaceId);
              }}
            />
          </TabsContent>
        ) : null}
        {views.map((view) => (
          <TabsContent key={view.name} value={view.name} className="flex-none">
            {viewType(view) === "table" ? (
              <TableView
                name={view.name}
                view={view}
                query={query}
                schema={schema}
                collectionPath={collectionPath}
                projectPath={projectPath}
                spacePath={spacePath}
                searchQuery={searchQuery}
                filters={query.merged.filter}
                sort={query.merged.sort}
                refreshToken={entriesVersion}
                createFocusSignal={tableCreateRequest.signal}
                createAsFolder={tableCreateRequest.asFolder}
                onClearSearch={() => setSearchQuery("")}
                onOpenEntry={(entryToOpen) => openPeek(entryToOpen)}
                onOpenNestedPeek={(entryToOpen) => openPeek(entryToOpen, true)}
                onOpenNestedCollection={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenFullPage={openFullPage}
                onOpenPath={openPath}
                onDuplicateEntry={(entryToDuplicate) =>
                  void duplicateRow(entryToDuplicate).catch(handleError)
                }
                onDeleteEntry={setDeleteEntry}
                onSchemaChange={(nextSchema) =>
                  setSchema(normalizeSchema(nextSchema))
                }
                onUpdateView={updateView}
                onCreateEntry={(title, asFolder) =>
                  createEntry(asFolder, title, false)
                }
              />
            ) : viewType(view) === "board" ? (
              <BoardView
                name={view.name}
                view={view}
                query={query}
                schema={schema}
                collectionPath={collectionPath}
                projectPath={projectPath}
                spacePath={spacePath}
                searchQuery={searchQuery}
                filters={query.merged.filter}
                sort={query.merged.sort}
                refreshToken={entriesVersion}
                createFocusSignal={boardCreateRequest.signal}
                createAsFolder={boardCreateRequest.asFolder}
                onClearSearch={() => setSearchQuery("")}
                onOpenEntry={(entryToOpen) => openPeek(entryToOpen)}
                onOpenNestedPeek={(entryToOpen) => openPeek(entryToOpen, true)}
                onOpenNestedCollection={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenFullPage={openFullPage}
                onOpenPath={openPath}
                onDuplicateEntry={(entryToDuplicate) =>
                  void duplicateRow(entryToDuplicate).catch(handleError)
                }
                onDeleteEntry={setDeleteEntry}
                onSchemaChange={(nextSchema) =>
                  setSchema(normalizeSchema(nextSchema))
                }
                onUpdateView={updateView}
                onCreateEntry={(title, asFolder, contextualDefaults) =>
                  createEntry(asFolder, title, false, contextualDefaults)
                }
              />
            ) : viewType(view) === "calendar" ? (
              <CalendarView
                name={view.name}
                view={view}
                schema={schema}
                collectionPath={collectionPath}
                projectPath={projectPath}
                spacePath={spacePath}
                searchQuery={searchQuery}
                filters={query.merged.filter}
                sort={query.merged.sort}
                refreshToken={entriesVersion}
                createFocusSignal={calendarCreateRequest.signal}
                createAsFolder={calendarCreateRequest.asFolder}
                onOpenEntry={(entryToOpen) => openPeek(entryToOpen)}
                onOpenNestedPeek={(entryToOpen) => openPeek(entryToOpen, true)}
                onOpenNestedCollection={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenFullPage={openFullPage}
                onOpenPath={openPath}
                onDuplicateEntry={(entryToDuplicate) =>
                  void duplicateRow(entryToDuplicate).catch(handleError)
                }
                onDeleteEntry={setDeleteEntry}
                onSchemaChange={(nextSchema) =>
                  setSchema(normalizeSchema(nextSchema))
                }
                onUpdateView={updateView}
                onCreateEntry={(title, asFolder, contextualDefaults) =>
                  createEntry(asFolder, title, false, contextualDefaults)
                }
              />
            ) : viewType(view) === "list" ? (
              <ListView
                name={view.name}
                view={view}
                query={query}
                schema={schema}
                collectionPath={collectionPath}
                projectPath={projectPath}
                spacePath={spacePath}
                searchQuery={searchQuery}
                filters={query.merged.filter}
                sort={query.merged.sort}
                refreshToken={entriesVersion}
                createFocusSignal={listCreateRequest.signal}
                createAsFolder={listCreateRequest.asFolder}
                onClearSearch={() => setSearchQuery("")}
                onOpenEntry={(entryToOpen) => openPeek(entryToOpen)}
                onOpenNestedPeek={(entryToOpen) => openPeek(entryToOpen, true)}
                onOpenNestedCollection={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenFullPage={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenPath={openPath}
                onDuplicateEntry={(entryToDuplicate) =>
                  void duplicateRow(entryToDuplicate).catch(handleError)
                }
                onDeleteEntry={setDeleteEntry}
                onCreateEntry={(title, asFolder) =>
                  createEntry(asFolder, title, false)
                }
              />
            ) : viewType(view) === "gallery" ? (
              <GalleryView
                name={view.name}
                view={view}
                query={query}
                schema={schema}
                collectionPath={collectionPath}
                projectPath={projectPath}
                spacePath={spacePath}
                searchQuery={searchQuery}
                filters={query.merged.filter}
                sort={query.merged.sort}
                refreshToken={entriesVersion}
                createFocusSignal={galleryCreateRequest.signal}
                createAsFolder={galleryCreateRequest.asFolder}
                onClearSearch={() => setSearchQuery("")}
                onOpenEntry={(entryToOpen) => openPeek(entryToOpen)}
                onOpenNestedPeek={(entryToOpen) => openPeek(entryToOpen, true)}
                onOpenNestedCollection={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenFullPage={(entryToOpen) =>
                  openDocument(entryToOpen.path, spaceId)
                }
                onOpenPath={openPath}
                onDuplicateEntry={(entryToDuplicate) =>
                  void duplicateRow(entryToDuplicate).catch(handleError)
                }
                onDeleteEntry={setDeleteEntry}
                onCreateEntry={(title, asFolder) =>
                  createEntry(asFolder, title, false)
                }
              />
            ) : (
              <ViewPlaceholder
                type={viewType(view)}
                name={view.name}
                schema={schema}
                collectionPath={collectionPath}
                projectPath={projectPath}
                spacePath={spacePath}
                searchQuery={searchQuery}
                refreshToken={entriesVersion}
                onOpenEntry={(entryToOpen) => openPeek(entryToOpen)}
                onDuplicateEntry={(entryToDuplicate) =>
                  void duplicateRow(entryToDuplicate).catch(handleError)
                }
                onDeleteEntry={setDeleteEntry}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>

      <DeleteDialogs
        viewOpen={deleteOpen}
        entry={deleteEntry}
        onViewOpenChange={setDeleteOpen}
        onEntryOpenChange={(open) => {
          if (!open) setDeleteEntry(null);
        }}
        onDeleteView={() => void deleteActiveView().catch(handleError)}
        onDeleteEntry={(entryToDelete) =>
          void deleteRow(entryToDelete).catch(handleError)
        }
      />
      <EntryPeekSheet
        target={peekTarget}
        spacePath={spacePath}
        projectPath={projectPath}
        spaceId={spaceId}
        onOpenChange={(open) => {
          if (!open) setPeekTarget(null);
        }}
        onOpenFullPage={openFullPage}
        onOpenPath={openPath}
        onConvertedEntry={(nextEntry, nested) => {
          setPeekTarget({ entry: nextEntry, nested });
          refreshEntries();
        }}
        onDuplicateEntry={(entryToDuplicate) => {
          setPeekTarget(null);
          void duplicateRow(entryToDuplicate).catch(handleError);
        }}
        onDeleteEntry={(entryToDelete) => {
          setPeekTarget(null);
          setDeleteEntry(entryToDelete);
        }}
        onSetTemplateDefault={setDefaultTemplateForMenu}
        onDuplicateTemplate={duplicateTemplateEntry}
        renderNested={(entryToOpen, actions) => (
          <CollectionScreen
            spacePath={spacePath}
            projectPath={projectPath}
            documentPath={entryToOpen.path}
            spaceId={spaceId}
            hasReadme
            headerActions={actions}
          />
        )}
      />
    </div>
  );
}

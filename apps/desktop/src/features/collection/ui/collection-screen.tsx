import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { normalizeSchema } from "@/features/properties";
import { detailPageToolbarClassName } from "@/shared/ui/page-layout";
import { useOpenEntryDocument } from "@/features/entry/selection";
import type { Entry } from "@/features/entry";
import { EntryDetailActions } from "@/features/entry/detail";
import type { GitSaveScopeTreeNode } from "@/features/git/app-shell";
import { useSpace, useSpaceTreeSync } from "@/features/space";
import { useViewQuery } from "@/features/collection/query/hooks";
import { DeleteDialogs } from "./delete-dialogs";
import {
  CollectionDocumentHeader,
  CollectionDocumentTab,
} from "./collection-document-surface";
import { DocumentSettings } from "./document-settings-popover";
import { EntryPeekSheet } from "./entry-peek-sheet";
import { handleError } from "../hooks/error-feedback";
import { CollectionSkeleton } from "./skeleton";
import { CollectionViewContent } from "./collection-view-content";
import { CollectionTabStrip } from "./view-tabs";
import { ViewActionBar } from "./view-action-bar";
import {
  useCollectionEntryActions,
  useCollectionActiveTab,
  useCollectionKeyboardShortcuts,
  useCollectionSaveShortcuts,
  useCollectionRefreshEvents,
  useCollectionSchemaState,
  useCollectionTemplates,
  useCollectionViewActions,
  useCollectionViewCreateFocus,
} from "../hooks";
import {
  collectionPathFor,
  humanize,
  readmePathFor,
  viewName,
  viewType,
} from "../lib/utils";
import type {
  CollectionRouteState,
  EntryPeekTarget,
  SettingsPane,
} from "../model";
import type { CollectionView } from "@/features/collection/query/model";
import * as m from "@/paraglide/messages.js";

interface CollectionScreenProps {
  spacePath: string;
  projectPath?: string | null;
  documentPath: string;
  spaceId: string;
  hasReadme: boolean;
  routeState?: CollectionRouteState;
  headerActions?: ReactNode;
}

const EMPTY_SAVE_SCOPE_TREE: readonly GitSaveScopeTreeNode[] = [];

export function CollectionScreen({
  spacePath,
  projectPath,
  documentPath,
  spaceId,
  hasReadme,
  routeState,
  headerActions,
}: CollectionScreenProps) {
  const collectionPath = useMemo(
    () => collectionPathFor(documentPath),
    [documentPath],
  );
  const readmePath = readmePathFor(collectionPath);
  const openDocument = useOpenEntryDocument();
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openDocument(path, targetSpaceId ?? spaceId),
    [openDocument, spaceId],
  );
  const saveScopeTree = useSpace(
    (state) => state.fileTrees[spaceId] ?? EMPTY_SAVE_SCOPE_TREE,
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
    refreshSchema,
    updateReadmeProperty,
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("main");
  const [renameValue, setRenameValue] = useState("");
  const [documentLabelOpen, setDocumentLabelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [peekTarget, setPeekTarget] = useState<EntryPeekTarget | null>(null);
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
  useCollectionRefreshEvents({
    spacePath,
    refreshSchema,
    refreshEntries,
  });

  const views = useMemo(
    () =>
      ((schema?.views ?? []) as CollectionView[]).filter((view) =>
        viewName(view),
      ),
    [schema],
  );
  const { activeTab, selectTab } = useCollectionActiveTab({
    collectionPath,
    hasReadme,
    routeState,
    schema,
    views,
  });
  const activeView = views.find((view) => view.name === activeTab) ?? null;
  const { focusActiveViewCreate, requests: createRequests } =
    useCollectionViewCreateFocus(activeView);
  const query = useViewQuery({
    spacePath,
    projectPath,
    collectionPath,
    viewName: activeView?.name ?? "",
    schema: schema ?? { columns: [], views: [] },
    view: activeView,
  });

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

  function openPeek(entryToOpen: Entry, nested = false) {
    setPeekTarget({ entry: entryToOpen, nested });
  }

  function openFullPage(entryToOpen: Entry) {
    setPeekTarget(null);
    openDocument(entryToOpen.path, spaceId);
  }

  useCollectionKeyboardShortcuts({
    activeTab,
    hasReadme,
    views,
    selectTab,
    moveActive,
    focusActiveViewCreate,
    createEntry,
  });
  useCollectionSaveShortcuts({
    activeTab,
    projectPath,
    readmePath,
    saveScopeTree,
    spacePath,
  });

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
      <CollectionDocumentHeader
        hasReadme={hasReadme}
        title={title}
        icon={icon}
        description={description}
        cover={cover}
        projectPath={projectPath}
        spacePath={spacePath}
        readmePath={readmePath}
        spaceId={spaceId}
        entry={entry}
        propertiesSchema={propertiesSchema}
        actions={effectiveHeaderActions}
        onOpenPath={openPath}
        onCreateReadmeForIdentity={() =>
          void createReadmeForIdentity().catch(handleError)
        }
        onUpdateIdentity={(field, value) =>
          void updateIdentity(field, value).catch(handleError)
        }
        onUpdateCover={(nextCover) =>
          void updateCover(nextCover).catch(handleError)
        }
        onReadmePropertyChange={updateReadmeProperty}
        onBodyFocus={() => selectTab("document")}
      />

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
                if (focusActiveViewCreate(asFolder)) {
                  return;
                }
                void createEntry(asFolder).catch(handleError);
              }}
            />
          )}
        </div>

        {hasReadme ? (
          <CollectionDocumentTab
            readmePath={readmePath}
            spaceId={spaceId}
            spacePath={spacePath}
            projectPath={projectPath}
            entry={entry}
            onDocumentPathChange={(path) => {
              setEntry((current) =>
                current ? { ...current, path } : current,
              );
              openDocument(path, spaceId);
            }}
          />
        ) : null}
        {views.map((view) => (
          <TabsContent key={view.name} value={view.name} className="flex-none">
            <CollectionViewContent
              view={view}
              query={query}
              schema={schema}
              collectionPath={collectionPath}
              projectPath={projectPath}
              spacePath={spacePath}
              searchQuery={searchQuery}
              refreshToken={entriesVersion}
              calendarScope={routeState?.calendarScope}
              createRequest={createRequests[viewType(view)]}
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
              onCalendarScopeChange={routeState?.onCalendarScopeChange}
              onCreateEntry={(title, asFolder, contextualDefaults) =>
                createEntry(asFolder, title, false, contextualDefaults)
              }
            />
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

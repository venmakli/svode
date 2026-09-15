import { useCallback, useEffect, useMemo, useState } from "react";
import {
  normalizeSchema,
  type RelationOpenTarget,
} from "@/features/properties";
import { useOpenPage } from "@/features/page/navigation";
import { useOpenScopeOwner } from "@/features/artifact";
import type { Page } from "@/features/page";
import { useOptionalPageDetailContext } from "@/features/page/scope-surface";
import type { ScopePeekRenderer } from "@/features/scope-surfaces";
import type { GitSaveScopeTreeNode } from "@/features/git/app-shell";
import { useSpace } from "@/features/space";
import { useViewQuery } from "../query/hooks";
import { DeleteDialogs } from "./delete-dialogs";
import { PagePeekSheet } from "./page-peek-sheet";
import { handleError } from "../hooks/error-feedback";
import { CollectionSkeleton } from "./skeleton";
import { definePageCollection } from "../persisted/page-collection-definition";
import { CollectionHost } from "./collection-host";
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
  readmePathFor,
  viewName,
  viewType,
} from "../lib/utils";
import type {
  CollectionRouteState,
  PagePeekTarget,
  SettingsPane,
} from "../model";
import type { CollectionView } from "../query/model";
import * as m from "@/paraglide/messages.js";

interface CollectionScreenProps {
  readOnly?: boolean;
  spacePath: string;
  projectPath?: string | null;
  pagePath: string;
  spaceId: string;
  routeState?: CollectionRouteState;
}

const EMPTY_SAVE_SCOPE_TREE: readonly GitSaveScopeTreeNode[] = [];

export interface CollectionViewsSurfaceProps extends CollectionScreenProps {
  renderPeek: ScopePeekRenderer;
}

export function CollectionViewsSurface({
  readOnly = false,
  spacePath,
  projectPath,
  pagePath,
  spaceId,
  routeState,
  renderPeek,
}: CollectionViewsSurfaceProps) {
  const [peekDeleteContext, setPeekDeleteContext] = useState<{
    page: Page;
    spacePath: string;
    projectPath: string | null | undefined;
    spaceId: string;
  } | null>(null);
  const entryContext = useOptionalPageDetailContext();
  const collectionPath = useMemo(() => collectionPathFor(pagePath), [pagePath]);
  const previousCollectionPath = collectionPathHandoffFromEntry(
    entryContext?.pathHandoff ?? null,
    collectionPath,
  );
  const readmePath = readmePathFor(collectionPath);
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openPage(path, targetSpaceId ?? spaceId),
    [openPage, spaceId],
  );
  const saveScopeTree = useSpace(
    (state) => state.fileTrees[spaceId] ?? EMPTY_SAVE_SCOPE_TREE,
  );
  const { schema, setSchema, loading, schemaError, refreshSchema } =
    useCollectionSchemaState({
      spacePath,
      collectionPath,
      previousCollectionPath,
    });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("main");
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [peekTarget, setPeekTarget] = useState<PagePeekTarget | null>(null);
  const {
    deleteEntry,
    setDeleteEntry,
    entriesVersion,
    refreshEntries,
    createEntry,
    duplicateRow,
    deleteRow,
  } = useCollectionEntryActions({
    schema,
    spacePath,
    projectPath,
    collectionPath,
    spaceId,
    openPage,
  });
  useCollectionRefreshEvents({
    spacePath,
    collectionPath,
    refreshSchema,
    refreshEntries,
  });

  const openPeek = useCallback((page: Page, nested = false) => {
    setPeekTarget({ page, nested });
  }, []);

  const views = useMemo(
    () =>
      ((schema?.views ?? []) as CollectionView[]).filter((view) =>
        viewName(view),
      ),
    [schema],
  );
  const { activeTab, selectTab } = useCollectionActiveTab({
    collectionPath,
    routeState,
    schema,
    views,
  });
  const activeView = views.find((view) => view.name === activeTab) ?? null;
  const definition = useMemo(
    () =>
      definePageCollection({
        collectionPath,
        onActivate: (page) => openPeek(page),
        schema: schema ?? { columns: [], views: [] },
        views,
      }),
    [collectionPath, openPeek, schema, views],
  );
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
    });
  }, [activeTab]);

  useEffect(() => {
    if (!readOnly) return;
    queueMicrotask(() => {
      if (!isLocalQueryPane(settingsPane)) setSettingsOpen(false);
      setDeleteOpen(false);
      setDeleteEntry(null);
    });
  }, [readOnly, setDeleteEntry, settingsPane]);

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
    openPage,
  });

  const openRelationPeek = useCallback(
    (target: RelationOpenTarget) => {
      const title = target.title.trim() || target.path;
      setPeekTarget({
        page: {
          path: target.path,
          body: "",
          meta: {
            title,
            icon: target.icon ?? null,
            created: "",
            updated: "",
            extra: {},
          },
        },
        nested: false,
        spaceId: target.spaceId ?? spaceId,
        spacePath: target.spacePath ?? spacePath,
        projectPath,
      });
    },
    [projectPath, spaceId, spacePath],
  );

  useCollectionKeyboardShortcuts({
    activeTab,
    views,
    selectTab,
    moveActive,
    focusActiveViewCreate,
    createEntry,
    readOnly,
  });
  useCollectionSaveShortcuts({
    projectPath,
    readmePath,
    saveScopeTree,
    spacePath,
    readOnly,
  });

  if (loading) {
    return (
      <div className="flex min-h-full flex-col">
        <CollectionSkeleton />
      </div>
    );
  }

  if (schemaError || !schema) {
    return (
      <div className="flex min-h-full flex-col">
        <div className="flex h-full flex-col gap-4 p-6">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <div className="font-medium">{m.collection_invalid_schema()}</div>
            <div className="mt-1 text-muted-foreground">{schemaError}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <CollectionHost
        activePresentationId={activeTab}
        definition={definition}
        onActivePresentationChange={selectTab}
        tabs={
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
            manageViewsLabel={m.collection_manage_views()}
            moreViewsLabel={m.collection_more_views()}
            readOnly={readOnly}
            views={views}
            onAddView={(type) => {
              if (!readOnly) void addView(type).catch(handleError);
            }}
            onReorderViews={(order) =>
              readOnly ? blockReadOnly() : reorder(order)
            }
            onTabChange={selectTab}
          />
        }
        actions={
          activeTab ? (
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
              readOnly={readOnly}
              onSearchOpenChange={setSearchOpen}
              onSearchQueryChange={setSearchQuery}
              onSettingsOpenChange={setSettingsOpen}
              onSettingsPaneChange={setSettingsPane}
              onRenameValueChange={setRenameValue}
              onRename={() => (readOnly ? blockReadOnly() : renameActiveView())}
              onUpdateView={(name, patch) =>
                readOnly ? blockReadOnly() : updateView(name, patch)
              }
              onDuplicateView={() =>
                readOnly ? blockReadOnly() : duplicateActiveView()
              }
              onDeleteViewRequest={() => {
                if (!readOnly) setDeleteOpen(true);
              }}
              onSchemaChange={(nextSchema) => {
                if (!readOnly) setSchema(normalizeSchema(nextSchema));
              }}
              autoConfigForType={autoConfigForType}
              onLoadTemplates={loadTemplatesForMenu}
              onCreateTemplate={createTemplateForMenu}
              onInstantiateTemplate={instantiateTemplateForMenu}
              onEditTemplate={editTemplate}
              onSetDefaultTemplate={setDefaultTemplateForMenu}
              onDuplicateTemplate={duplicateTemplateForMenu}
              onDeleteTemplate={deleteTemplateForMenu}
              onReorderTemplates={reorderTemplatesForMenu}
              onCreatePage={(asFolder) => {
                if (focusActiveViewCreate(asFolder)) return;
                void createEntry(asFolder).catch(handleError);
              }}
            />
          ) : null
        }
        presentation={
          activeView
            ? {
                readOnly,
                view: activeView,
                query,
                schema,
                collectionPath,
                previousCollectionPath,
                projectPath,
                spacePath,
                searchQuery,
                refreshToken: entriesVersion,
                calendarScope: routeState?.calendarScope,
                createRequest: createRequests[viewType(activeView)],
                onClearSearch: () => setSearchQuery(""),
                onOpenNestedPeek: (entryToOpen) => openPeek(entryToOpen, true),
                onOpenNestedCollection: (entryToOpen) =>
                  openScopeOwner({
                    kind: "collection",
                    path: entryToOpen.path,
                    spaceId,
                  }),
                onOpenFullPage: (page) => openPage(page.path, spaceId),
                onOpenPath: openPath,
                onOpenRelationTarget: openRelationPeek,
                onDuplicatePage: (pageToDuplicate) => {
                  if (!readOnly) {
                    void duplicateRow(pageToDuplicate).catch(handleError);
                  }
                },
                onDeletePage: (pageToDelete) => {
                  if (!readOnly) setDeleteEntry(pageToDelete);
                },
                onSchemaChange: (nextSchema) => {
                  if (!readOnly) setSchema(normalizeSchema(nextSchema));
                },
                onUpdateView: (name, patch) => {
                  if (readOnly) {
                    return Promise.reject(
                      new Error(m.repository_work_status_read_only()),
                    );
                  }
                  return updateView(name, patch);
                },
                onCalendarScopeChange: routeState?.onCalendarScopeChange,
                onCreatePage: (title, asFolder, contextualDefaults) => {
                  if (readOnly) {
                    return Promise.reject(
                      new Error(m.repository_work_status_read_only()),
                    );
                  }
                  return createEntry(
                    asFolder,
                    title,
                    false,
                    contextualDefaults,
                  );
                },
              }
            : null
        }
      />

      <DeleteDialogs
        viewOpen={!readOnly && deleteOpen}
        entry={
          peekDeleteContext?.page === deleteEntry
            ? deleteEntry
            : readOnly
              ? null
              : deleteEntry
        }
        onViewOpenChange={setDeleteOpen}
        onEntryOpenChange={(open) => {
          if (!open) setDeleteEntry(null);
        }}
        onDeleteView={() => void deleteActiveView().catch(handleError)}
        onDeletePage={(pageToDelete) =>
          void deleteRow(
            pageToDelete,
            peekDeleteContext?.page === pageToDelete
              ? peekDeleteContext
              : undefined,
          ).catch(handleError)
        }
      />
      <PagePeekSheet
        readOnly={readOnly}
        target={peekTarget}
        spacePath={spacePath}
        projectPath={projectPath}
        spaceId={spaceId}
        onOpenChange={(open) => {
          if (!open) setPeekTarget(null);
        }}
        onOpenPath={openPath}
        onConvertedPage={(nextEntry, nested) => {
          setPeekTarget((current) =>
            current ? { ...current, page: nextEntry, nested } : null,
          );
          refreshEntries();
        }}
        onDuplicatePage={(entryToDuplicate) => {
          setPeekTarget(null);
          void duplicateRow(entryToDuplicate, {
            spacePath: peekTarget?.spacePath ?? spacePath,
            projectPath: peekTarget?.projectPath ?? projectPath,
            spaceId: peekTarget?.spaceId ?? spaceId,
          }).catch(handleError);
        }}
        onDeletePage={(entryToDelete) => {
          setPeekDeleteContext({
            page: entryToDelete,
            spacePath: peekTarget?.spacePath ?? spacePath,
            projectPath: peekTarget?.projectPath ?? projectPath,
            spaceId: peekTarget?.spaceId ?? spaceId,
          });
          setPeekTarget(null);
          setDeleteEntry(entryToDelete);
        }}
        onSetTemplateDefault={setDefaultTemplateForMenu}
        onDuplicateTemplate={duplicateTemplateEntry}
        renderPeek={renderPeek}
      />
    </div>
  );
}

function isLocalQueryPane(pane: SettingsPane) {
  return (
    pane === "filter" ||
    pane === "filterField" ||
    pane === "filterEditor" ||
    pane === "sort" ||
    pane === "sortField" ||
    pane === "sortEditor" ||
    pane === "group"
  );
}

function blockReadOnly(): Promise<void> {
  return Promise.resolve();
}

function collectionPathHandoffFromEntry(
  handoff: { previousPath: string; path: string } | null,
  collectionPath: string,
) {
  if (!handoff || collectionPathFor(handoff.path) !== collectionPath) {
    return null;
  }
  return collectionPathFor(handoff.previousPath);
}

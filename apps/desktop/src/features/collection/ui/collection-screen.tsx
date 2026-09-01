import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  normalizeSchema,
  type RelationOpenTarget,
} from "@/features/properties";
import { useOpenPage } from "@/features/page/navigation";
import { useOpenScopeOwner } from "@/features/artifact";
import type { Page } from "@/features/page";
import { PageDetailActions } from "@/features/page/detail";
import {
  PageDetailProvider,
  useOptionalPageDetailContext,
} from "@/features/page/scope-surface";
import { ScopeOwnerHeader } from "@/features/scope-surfaces";
import type { GitSaveScopeTreeNode } from "@/features/git/app-shell";
import { useSpace, useSpaceTreeSync } from "@/features/space";
import { useViewQuery } from "../query/hooks";
import { DeleteDialogs } from "./delete-dialogs";
import { PagePeekSheet } from "./page-peek-sheet";
import { handleError } from "../hooks/error-feedback";
import { CollectionSkeleton } from "./skeleton";
import { definePageCollection } from "../persisted/page-collection-definition";
import { PersistedCollectionHost } from "../persisted/persisted-collection-host";
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
  CollectionPeekSurfaceState,
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
  headerActions?: ReactNode;
}

const EMPTY_SAVE_SCOPE_TREE: readonly GitSaveScopeTreeNode[] = [];

function CollectionScreen({
  readOnly = false,
  spacePath,
  projectPath,
  pagePath,
  spaceId,
  routeState,
  headerActions,
}: CollectionScreenProps) {
  const collectionPath = collectionPathFor(pagePath);
  const readmePath = readmePathFor(collectionPath);
  const openPage = useOpenPage();
  const openPath = useCallback(
    (path: string, targetSpaceId?: string | null) =>
      openPage(path, targetSpaceId ?? spaceId),
    [openPage, spaceId],
  );

  return (
    <PageDetailProvider
      spacePath={spacePath}
      projectPath={projectPath}
      spaceId={spaceId}
      readmePath={readmePath}
      ownerPath={collectionPath || "."}
      onOpenPath={openPath}
    >
      <CollectionScreenContent
        readOnly={readOnly}
        spacePath={spacePath}
        projectPath={projectPath}
        pagePath={pagePath}
        spaceId={spaceId}
        routeState={routeState}
        headerActions={headerActions}
      />
    </PageDetailProvider>
  );
}

export interface CollectionViewsSurfaceProps extends Omit<
  CollectionScreenProps,
  "headerActions"
> {
  renderNested?: (
    entry: Page,
    actions: ReactNode,
    routeState: CollectionRouteState,
    surfaceState: CollectionPeekSurfaceState,
    sessionKey: string,
  ) => ReactNode;
}

function CollectionScreenContent(props: CollectionScreenProps) {
  const entryContext = useOptionalPageDetailContext();
  return (
    <CollectionViewsSurfaceInternal
      {...props}
      showOwnerChrome
      ownerEntry={entryContext?.page ?? null}
      setOwnerEntry={entryContext?.setPage}
    />
  );
}

export function CollectionViewsSurface(props: CollectionViewsSurfaceProps) {
  return (
    <CollectionViewsSurfaceInternal
      {...props}
      showOwnerChrome={false}
      ownerEntry={null}
    />
  );
}

interface CollectionViewsSurfaceInternalProps extends CollectionScreenProps {
  showOwnerChrome: boolean;
  ownerEntry: Page | null;
  setOwnerEntry?: Dispatch<SetStateAction<Page | null>>;
  renderNested?: (
    entry: Page,
    actions: ReactNode,
    routeState: CollectionRouteState,
    surfaceState: CollectionPeekSurfaceState,
    sessionKey: string,
  ) => ReactNode;
}

function CollectionViewsSurfaceInternal({
  readOnly = false,
  spacePath,
  projectPath,
  pagePath,
  spaceId,
  routeState,
  headerActions,
  showOwnerChrome,
  ownerEntry: entry,
  setOwnerEntry: setEntry,
  renderNested,
}: CollectionViewsSurfaceInternalProps) {
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
  const reloadTreePathParents = useSpaceTreeSync(
    (state) => state.reloadTreePathParents,
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
    duplicateDetailEntry,
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
        schema: schema ?? { columns: [], views: [] },
        views,
      }),
    [collectionPath, schema, views],
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

  function openPeek(entryToOpen: Page, nested = false) {
    setPeekTarget({ page: entryToOpen, nested });
  }

  function openFullPage(
    entryToOpen: Page,
    targetSpaceId?: string | null,
    targetViewName?: string | null,
    targetSurfaceId: CollectionPeekSurfaceState["surfaceId"] = "collection",
  ) {
    setPeekTarget(null);
    if (targetViewName !== undefined) {
      routeState?.onViewNameChange(targetViewName);
    }
    const targetOwnerSpaceId = targetSpaceId ?? spaceId;
    if (targetViewName !== undefined) {
      openScopeOwner(
        {
          kind: "collection",
          path: entryToOpen.path,
          spaceId: targetOwnerSpaceId,
        },
        {
          scopeOpenIntent: { kind: "target", surfaceId: targetSurfaceId },
        },
      );
    } else {
      openPage(entryToOpen.path, targetOwnerSpaceId);
    }
  }

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
        {showOwnerChrome ? <ScopeOwnerHeader readOnly={readOnly} /> : null}
        <CollectionSkeleton />
      </div>
    );
  }

  if (schemaError || !schema) {
    return (
      <div className="flex min-h-full flex-col">
        {showOwnerChrome ? <ScopeOwnerHeader readOnly={readOnly} /> : null}
        <div className="flex h-full flex-col gap-4 p-6">
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <div className="font-medium">{m.collection_invalid_schema()}</div>
            <div className="mt-1 text-muted-foreground">{schemaError}</div>
          </div>
        </div>
      </div>
    );
  }

  const effectiveHeaderActions =
    headerActions ??
    (entry ? (
      <PageDetailActions
        page={entry}
        spacePath={spacePath}
        projectPath={projectPath}
        spaceId={spaceId}
        onConverted={(nextEntry, nested) => {
          setEntry?.(nextEntry);
          openPage(nextEntry.path, spaceId);
          if (nested) void reloadTreePathParents(spaceId, [nextEntry.path]);
        }}
        onDuplicatePage={(entryToDuplicate) =>
          void duplicateDetailEntry(entryToDuplicate).catch(handleError)
        }
        onDeletePage={setDeleteEntry}
        readOnly={readOnly}
      />
    ) : null);

  return (
    <div className="flex min-h-full flex-col">
      {showOwnerChrome ? (
        <ScopeOwnerHeader
          readOnly={readOnly}
          actions={effectiveHeaderActions}
        />
      ) : null}

      <PersistedCollectionHost
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
              onCreateEntry={(asFolder) => {
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
                onOpenEntry: (entryToOpen) => openPeek(entryToOpen),
                onOpenNestedPeek: (entryToOpen) => openPeek(entryToOpen, true),
                onOpenNestedCollection: (entryToOpen) =>
                  openScopeOwner({
                    kind: "collection",
                    path: entryToOpen.path,
                    spaceId,
                  }),
                onOpenFullPage: openFullPage,
                onOpenPath: openPath,
                onOpenRelationTarget: openRelationPeek,
                onDuplicateEntry: (entryToDuplicate) => {
                  if (!readOnly) {
                    void duplicateRow(entryToDuplicate).catch(handleError);
                  }
                },
                onDeleteEntry: (entryToDelete) => {
                  if (!readOnly) setDeleteEntry(entryToDelete);
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
                onCreateEntry: (title, asFolder, contextualDefaults) => {
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
        entry={readOnly ? null : deleteEntry}
        onViewOpenChange={setDeleteOpen}
        onEntryOpenChange={(open) => {
          if (!open) setDeleteEntry(null);
        }}
        onDeleteView={() => void deleteActiveView().catch(handleError)}
        onDeleteEntry={(entryToDelete) =>
          void deleteRow(entryToDelete).catch(handleError)
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
        onOpenFullPage={openFullPage}
        onOpenPath={openPath}
        onConvertedPage={(nextEntry, nested) => {
          setPeekTarget({ page: nextEntry, nested });
          refreshEntries();
        }}
        onDuplicatePage={(entryToDuplicate) => {
          setPeekTarget(null);
          void duplicateRow(entryToDuplicate).catch(handleError);
        }}
        onDeletePage={(entryToDelete) => {
          setPeekTarget(null);
          setDeleteEntry(entryToDelete);
        }}
        onSetTemplateDefault={setDefaultTemplateForMenu}
        onDuplicateTemplate={duplicateTemplateEntry}
        renderNested={
          renderNested ??
          ((entryToOpen, actions) => (
            <CollectionScreen
              readOnly={readOnly}
              spacePath={spacePath}
              projectPath={projectPath}
              pagePath={entryToOpen.path}
              spaceId={spaceId}
              headerActions={actions}
            />
          ))
        }
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

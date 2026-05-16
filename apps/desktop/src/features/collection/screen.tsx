import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { Database, FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EntryIdentityHeader } from "@/features/editor/entry-identity-header";
import { TitleZone } from "@/features/editor/title-zone";
import { PlateDocumentEditor } from "@/features/editor/plate/plate-editor";
import { PropertyPanel } from "@/features/properties/property-panel";
import { normalizeSchema } from "@/features/properties/utils";
import type { EntrySchemaResult } from "@/features/properties/types";
import { useLayoutStore } from "@/stores/layout";
import { useSpaceStore } from "@/stores/space";
import { useViewQuery } from "@/features/collection-query/use-view-query";
import { DeleteDialogs } from "./delete-dialogs";
import { DocumentSettings } from "./document-settings-popover";
import { EntryPeekSheet, type EntryPeekTarget } from "./entry-peek-sheet";
import { handleError } from "./errors";
import { CollectionSkeleton } from "./skeleton";
import {
  collectionTabTriggerClassName,
  handleHorizontalWheel,
  SortableViewTab,
} from "./view-tabs";
import { ViewPlaceholder } from "./view-placeholder";
import { BoardView } from "./board-view";
import { TableView } from "./table-view";
import { ViewActionBar } from "./view-action-bar";
import {
  type ActiveTab,
  type SettingsPane,
  collectionPathFor,
  humanize,
  isEditableTarget,
  nextTableViewName,
  readmePathFor,
  viewName,
  viewType,
} from "./utils";
import type {
  CollectionView,
  ViewType,
} from "@/features/collection-query/types";
import type { CollectionSchema } from "@/features/properties/types";
import type { Entry, EntryCover } from "@/features/editor/types";
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
  const { openDocument } = useLayoutStore();
  const { refreshTree, updateNodeMeta } = useSpaceStore();
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [parentSchema, setParentSchema] = useState<EntrySchemaResult | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>("document");
  const [loading, setLoading] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("main");
  const [renameValue, setRenameValue] = useState("");
  const [documentLabelOpen, setDocumentLabelOpen] = useState(false);
  const [documentLabel, setDocumentLabel] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
  const [peekTarget, setPeekTarget] = useState<EntryPeekTarget | null>(null);
  const [entriesVersion, setEntriesVersion] = useState(0);
  const [tableCreateRequest, setTableCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const [boardCreateRequest, setBoardCreateRequest] = useState({
    signal: 0,
    asFolder: false,
  });
  const initializedCollectionRef = useRef<string | null>(null);
  const tabScrollerRef = useRef<HTMLDivElement | null>(null);

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setSchemaError(null);
    try {
      const nextSchema = await invoke<CollectionSchema>(
        "get_collection_schema",
        {
          space: spacePath,
          collectionPath,
        },
      );
      setSchema(normalizeSchema(nextSchema));
      if (hasReadme) {
        const nextEntry = await invoke<Entry>("read_entry", {
          space: spacePath,
          path: readmePath,
        });
        setEntry(nextEntry);
      } else {
        setEntry(null);
      }
      let parent: EntrySchemaResult | null = null;
      const parentCollectionPath = collectionPath.includes("/")
        ? collectionPath.slice(0, collectionPath.lastIndexOf("/"))
        : "";
      if (hasReadme) {
        parent = await invoke<CollectionSchema>("get_collection_schema", {
          space: spacePath,
          collectionPath: parentCollectionPath,
        })
          .then((parentCollectionSchema) => ({
            schema: parentCollectionSchema,
            collectionRootPath: parentCollectionPath,
          }))
          .catch(() => null);
      }
      setParentSchema(parent);
    } catch (error) {
      console.error("Failed to load collection:", error);
      setSchemaError(String(error));
    } finally {
      setLoading(false);
    }
  }, [collectionPath, hasReadme, readmePath, spacePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
        selectTab(hasReadme ? "document" : (views[0]?.name ?? "document"));
      }
      return;
    }
    initializedCollectionRef.current = key;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view");
    if (requested && views.some((view) => view.name === requested)) {
      selectTab(requested);
      return;
    }
    if (hasReadme) {
      selectTab("document");
      return;
    }
    selectTab(views[0]?.name ?? "document");
  }, [activeTab, collectionPath, hasReadme, schema, selectTab, views]);

  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSettingsOpen(false);
    setDocumentLabelOpen(false);
  }, [activeTab]);

  useEffect(() => {
    const scroller = tabScrollerRef.current;
    if (!scroller) return;
    const selector =
      activeTab === "document"
        ? '[data-collection-tab="document"]'
        : `[data-collection-tab="${CSS.escape(activeTab)}"]`;
    scroller
      .querySelector<HTMLElement>(selector)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeTab, views]);

  useEffect(() => {
    if (activeView) setRenameValue(activeView.name);
  }, [activeView]);

  useEffect(() => {
    setDocumentLabel(schema?.document?.label ?? m.collection_document_tab());
  }, [schema]);

  async function createReadmeForIdentity() {
    if (hasReadme) return entry;
    const created = await invoke<Entry>("create_entry", {
      space: spacePath,
      parentPath: collectionPath,
      title: humanize(collectionPath),
      projectPath: projectPath ?? null,
    });
    let nextEntry = created;
    if (created.path.toLowerCase() !== readmePath.toLowerCase()) {
      await invoke("rename_entry", {
        space: spacePath,
        from: created.path,
        to: readmePath,
        projectPath: projectPath ?? null,
      });
      nextEntry = await invoke<Entry>("read_entry", {
        space: spacePath,
        path: readmePath,
      });
    }
    await refreshTree(spaceId);
    openDocument(readmePath, spaceId);
    setEntry(nextEntry);
    return nextEntry;
  }

  async function updateIdentity(
    field: "title" | "icon" | "description",
    value: unknown,
  ) {
    if (!hasReadme) {
      const created = await createReadmeForIdentity();
      if (!created) return;
      const updated = await invoke<Entry>("update_entry_field", {
        space: spacePath,
        filePath: readmePath,
        field,
        value,
        projectPath: projectPath ?? null,
      });
      setEntry(updated);
      return;
    }
    const updated = await invoke<Entry>("update_entry_field", {
      space: spacePath,
      filePath: readmePath,
      field,
      value,
      projectPath: projectPath ?? null,
    });
    setEntry(updated);
    updateNodeMeta(
      spaceId,
      readmePath,
      updated.meta.title,
      updated.meta.icon,
      updated.meta.description ?? null,
    );
  }

  async function updateCover(nextCover: EntryCover | null) {
    if (!hasReadme) return;
    setEntry((current) =>
      current
        ? { ...current, meta: { ...current.meta, cover: nextCover } }
        : current,
    );
    const updated = await invoke<Entry>("update_entry_field", {
      space: spacePath,
      filePath: readmePath,
      field: "cover",
      value: nextCover,
      projectPath: projectPath ?? null,
    });
    setEntry(updated);
  }

  async function addView() {
    if (!schema) return;
    const view = {
      type: "table",
      name: nextTableViewName(views),
      visible_fields: ["title", ...schema.columns.map((column) => column.name)],
    };
    const next = await invoke<CollectionSchema>("add_view", {
      space: spacePath,
      collectionPath,
      view,
      position: null,
      projectPath: projectPath ?? null,
    });
    const normalized = normalizeSchema(next);
    setSchema(normalized);
    const created = ((normalized.views ?? []) as CollectionView[]).at(-1);
    if (created) {
      selectTab(created.name);
      setSettingsPane("main");
      setSettingsOpen(true);
    }
  }

  function autoConfigForType(nextType: ViewType) {
    if (!schema) return {};
    if (nextType === "board") {
      const groupBy =
        schema.columns.find((column) => column.type === "status")?.name ??
        schema.columns.find((column) => column.type === "select")?.name ??
        schema.columns.find((column) => column.type === "person")?.name ??
        null;
      return groupBy
        ? { type: nextType, group_by: groupBy }
        : { type: nextType, group_by: null };
    }
    if (nextType === "calendar") {
      const dateField =
        schema.columns.find((column) => column.type === "date")?.name ?? null;
      return dateField
        ? { type: nextType, date_field: dateField }
        : { type: nextType, date_field: null };
    }
    return { type: nextType };
  }

  async function updateView(
    viewNameToUpdate: string,
    patch: Record<string, unknown>,
  ) {
    const next = await invoke<CollectionSchema>("update_view", {
      space: spacePath,
      collectionPath,
      viewName: viewNameToUpdate,
      patch,
      projectPath: projectPath ?? null,
    });
    setSchema(normalizeSchema(next));
  }

  async function renameActiveView() {
    if (!activeView) return;
    const nextName = renameValue.trim();
    if (!nextName || nextName === activeView.name) return;
    const next = await invoke<CollectionSchema>("rename_view", {
      space: spacePath,
      collectionPath,
      oldName: activeView.name,
      newName: nextName,
      projectPath: projectPath ?? null,
    });
    setSchema(normalizeSchema(next));
    selectTab(nextName);
  }

  async function duplicateActiveView() {
    if (!activeView) return;
    const next = await invoke<CollectionSchema>("duplicate_view", {
      space: spacePath,
      collectionPath,
      viewName: activeView.name,
      newName: `${activeView.name} copy`,
      projectPath: projectPath ?? null,
    });
    const normalized = normalizeSchema(next);
    setSchema(normalized);
    const created = ((normalized.views ?? []) as CollectionView[]).at(-1);
    if (created) selectTab(created.name);
  }

  async function createEntry(
    asFolder = false,
    title: string = String(m.editor_untitled()),
    openAfterCreate = true,
    contextualDefaults?: Record<string, unknown>,
  ) {
    const created = await invoke<Entry>("create_entry", {
      space: spacePath,
      parentPath: collectionPath,
      title,
      contextualDefaults: contextualDefaults ?? null,
      projectPath: projectPath ?? null,
    });
    let nextEntry = created;
    if (asFolder) {
      nextEntry = await invoke<Entry>("convert_entry_to_folder", {
        space: spacePath,
        entryId: created.meta.id,
        projectPath: projectPath ?? null,
      });
    }
    setEntriesVersion((version) => version + 1);
    await refreshTree(spaceId);
    if (openAfterCreate) {
      openDocument(nextEntry.path, spaceId);
    }
    return nextEntry;
  }

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

  async function duplicateRow(entryToDuplicate: Entry) {
    const duplicated = await invoke<Entry>("duplicate_entry", {
      space: spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    setEntriesVersion((version) => version + 1);
    await refreshTree(spaceId);
    openDocument(duplicated.path, spaceId);
  }

  async function deleteRow(entryToDelete: Entry) {
    await invoke("delete_entry", {
      space: spacePath,
      path: entryToDelete.path,
      projectPath: projectPath ?? null,
    });
    setDeleteEntry(null);
    setEntriesVersion((version) => version + 1);
    await refreshTree(spaceId);
  }

  async function deleteActiveView() {
    if (!activeView) return;
    const next = await invoke<CollectionSchema>("delete_view", {
      space: spacePath,
      collectionPath,
      viewName: activeView.name,
      projectPath: projectPath ?? null,
    });
    const normalized = normalizeSchema(next);
    setSchema(normalized);
    selectTab(
      hasReadme
        ? "document"
        : (((normalized.views ?? []) as CollectionView[])[0]?.name ??
            "document"),
    );
    setDeleteOpen(false);
  }

  function openPeek(entryToOpen: Entry, nested = false) {
    setPeekTarget({ entry: entryToOpen, nested });
  }

  function openFullPage(entryToOpen: Entry) {
    setPeekTarget(null);
    openDocument(entryToOpen.path, spaceId);
  }

  async function reorder(nextOrder: string[]) {
    const next = await invoke<CollectionSchema>("reorder_views", {
      space: spacePath,
      collectionPath,
      newOrder: nextOrder,
      projectPath: projectPath ?? null,
    });
    setSchema(normalizeSchema(next));
  }

  async function saveDocumentLabel() {
    const label = documentLabel.trim() || null;
    const next = await invoke<CollectionSchema>("update_document_label", {
      space: spacePath,
      collectionPath,
      label,
      projectPath: projectPath ?? null,
    });
    setSchema(normalizeSchema(next));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = views.findIndex((view) => view.name === active.id);
    const newIndex = views.findIndex((view) => view.name === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    void reorder(
      arrayMove(
        views.map((view) => view.name),
        oldIndex,
        newIndex,
      ),
    ).catch(handleError);
  }

  function moveActive(offset: number) {
    if (!activeView) return;
    const index = views.findIndex((view) => view.name === activeView.name);
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= views.length) return;
    void reorder(
      arrayMove(
        views.map((view) => view.name),
        index,
        nextIndex,
      ),
    ).catch(handleError);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        moveActive(-1);
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
        void createEntry(true).catch(handleError);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const propertiesSchema =
    parentSchema &&
    (parentSchema.collectionRootPath ?? parentSchema.collection_root_path) !==
      collectionPath
      ? { ...parentSchema, schema: normalizeSchema(parentSchema.schema) }
      : null;
  const hasHeaderProperties = Boolean(
    propertiesSchema &&
    propertiesSchema.schema.columns.length > 0 &&
    entry?.meta.id,
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-4 px-6 pb-3 pt-5">
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
              titleClassName={headerActions ? "max-w-none" : "max-w-4xl"}
              actions={headerActions}
              coverSize={headerActions ? "compact" : "default"}
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
              filePath={readmePath}
              metaId={entry.meta.id}
              schemaResult={propertiesSchema}
              values={entry.meta.extra ?? {}}
              mode="full"
              onValueChange={async (field, value) => {
                const updated = await invoke<Entry>("update_entry_field", {
                  space: spacePath,
                  filePath: readmePath,
                  field,
                  value,
                  projectPath: projectPath ?? null,
                });
                setEntry(updated);
              }}
            />
          </div>
        ) : null}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={selectTab}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex shrink-0 items-center gap-2 px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div
              ref={tabScrollerRef}
              className="scrollbar-hide min-w-0 flex-1 overflow-x-auto overflow-y-hidden [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)]"
              onWheel={handleHorizontalWheel}
            >
              <div className="inline-flex w-max max-w-none items-center gap-2">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <TabsList className="w-max max-w-none flex-nowrap">
                    {hasReadme ? (
                      <TabsTrigger
                        value="document"
                        data-collection-tab="document"
                        className={`${collectionTabTriggerClassName} sticky left-0 z-10 bg-background shadow-sm`}
                      >
                        <FileText />
                        <span className="truncate">{documentLabelValue}</span>
                      </TabsTrigger>
                    ) : null}
                    <SortableContext
                      items={views.map((view) => view.name)}
                      strategy={horizontalListSortingStrategy}
                    >
                      {views.map((view) => (
                        <SortableViewTab key={view.name} view={view} />
                      ))}
                    </SortableContext>
                  </TabsList>
                </DndContext>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="sticky right-0 z-10 flex-none bg-background shadow-sm"
                      onClick={() => void addView().catch(handleError)}
                    >
                      <Plus />
                      <span className="sr-only">{m.collection_add_view()}</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{m.collection_add_view()}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
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
              onCreateEntry={(asFolder) => {
                if (activeView && viewType(activeView) === "table") {
                  focusTableCreate(asFolder);
                  return;
                }
                if (activeView && viewType(activeView) === "board") {
                  focusBoardCreate(asFolder);
                  return;
                }
                void createEntry(asFolder).catch(handleError);
              }}
            />
          )}
        </div>

        {hasReadme ? (
          <TabsContent value="document" className="min-h-0 overflow-hidden">
            <PlateDocumentEditor bodyOnly bodyOnlyMeta={entry?.meta ?? null} />
          </TabsContent>
        ) : null}
        {views.map((view) => (
          <TabsContent
            key={view.name}
            value={view.name}
            className={
              viewType(view) === "table" || viewType(view) === "board"
                ? "min-h-0 overflow-hidden"
                : "min-h-0 overflow-auto"
            }
          >
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
        onDuplicateEntry={(entryToDuplicate) => {
          setPeekTarget(null);
          void duplicateRow(entryToDuplicate).catch(handleError);
        }}
        onDeleteEntry={(entryToDelete) => {
          setPeekTarget(null);
          setDeleteEntry(entryToDelete);
        }}
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

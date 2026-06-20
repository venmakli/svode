import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { arrayMove } from "@dnd-kit/sortable";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { listen } from "@/platform/native/events";
import { Database } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { EntryIdentityHeader } from "@/features/editor";
import { TitleZone } from "@/features/editor";
import { PlateDocumentEditor } from "@/features/editor";
import { PropertyPanel } from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import {
  propertyFieldSavePolicy,
  type EntrySchemaResult,
} from "@/features/properties";
import {
  detailPageHeaderClassName,
  detailPageToolbarClassName,
} from "@/shared/ui/page-layout";
import { isEntryTreeMetaField, useEntryFieldSave } from "@/features/entry";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpace } from "@/features/space";
import { useViewQuery } from "@/features/collection/query";
import { DeleteDialogs } from "./delete-dialogs";
import { EntryDetailActions } from "./entry-detail-actions";
import { EntrySystemFields } from "./entry-system-fields";
import { DocumentSettings } from "./document-settings-popover";
import { EntryPeekSheet, type EntryPeekTarget } from "./entry-peek-sheet";
import { handleError } from "../lib/errors";
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
  createTemplate as createTemplateApi,
  deleteTemplate,
  duplicateTemplate as duplicateTemplateApi,
  instantiateTemplate,
  listTemplates,
  readTemplateEntry,
  reorderTemplates,
  setDefaultTemplate,
} from "../api";
import {
  collectionPathFor,
  humanize,
  isEditableTarget,
  nextTableViewName,
  nextViewName,
  normalizeEntryPath,
  readmePathFor,
  viewName,
  viewType,
} from "../lib/utils";
import type { ActiveTab, SettingsPane } from "../model";
import {
  templateHeadPath,
  type TemplateInfo,
  type TemplateKind,
} from "../model";
import type { CollectionView, ViewType } from "@/features/collection/query";
import type { CollectionSchema } from "@/features/properties";
import type { Entry, EntryCover } from "@/features/entry";
import * as m from "@/paraglide/messages.js";

interface CollectionScreenProps {
  spacePath: string;
  projectPath?: string | null;
  documentPath: string;
  spaceId: string;
  hasReadme: boolean;
  headerActions?: ReactNode;
}

interface FileEvent {
  path: string;
}

function isMarkdownEntryPath(path: string) {
  return path.replace(/\\/g, "/").toLowerCase().endsWith(".md");
}

function entryTemplateSlug(collectionPath: string, entryPath: string) {
  const normalizedCollectionPath = normalizeEntryPath(collectionPath);
  const normalizedEntryPath = normalizeEntryPath(entryPath);
  const prefix = normalizedCollectionPath
    ? `${normalizedCollectionPath}/.templates/`
    : ".templates/";
  const rest = normalizedEntryPath.startsWith(prefix)
    ? normalizedEntryPath.slice(prefix.length)
    : normalizedEntryPath;
  return rest.replace(/\/README\.md$/i, "").replace(/\.md$/i, "");
}

function isMissingTemplateError(error: unknown) {
  const message = String(error).toLowerCase();
  return message.includes("not found") || message.includes("filenotfound");
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
  const { openDocument } = useEntrySelectionStore();
  const {
    reloadTreeParent,
    reloadTreePathParent,
    reloadTreePathParents,
    patchEntryTreeMeta,
    removeTreePath,
  } = useSpace();
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
  const applyReadmeEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntry((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [],
  );
  const updateReadmeField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate: applyReadmeEntryUpdate,
    onSaved: (updated, context) => {
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          readmePath,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
      }
    },
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

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const reloadEntries = (event: { payload: FileEvent }) => {
      if (!isMarkdownEntryPath(event.payload.path)) return;
      setEntriesVersion((version) => version + 1);
    };

    for (const eventName of ["file:created", "file:changed", "file:deleted"]) {
      listen<FileEvent>(eventName, reloadEntries).then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      });
    }

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

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
    await reloadTreePathParent(spaceId, readmePath);
    await reloadTreeParent(spaceId, collectionPath);
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
      await updateReadmeField(created, field, value, { flush: true });
      return;
    }
    if (!entry) return;
    await updateReadmeField(entry, field, value);
  }

  async function updateCover(nextCover: EntryCover | null) {
    if (!hasReadme) return;
    if (!entry) return;
    await updateReadmeField(entry, "cover", nextCover);
  }

  async function addView(type: ViewType = "table") {
    if (!schema) return;
    const defaultFields = [
      "title",
      ...schema.columns.map((column) => column.name),
    ];
    const view = {
      name:
        type === "table"
          ? nextTableViewName(views)
          : nextViewName(views, viewTypeDefaultName(type)),
      visible_fields: defaultFields,
      ...autoConfigForType(type),
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
        schema.columns.find(
          (column) =>
            (column.type === "actor" || column.type === "person") &&
            !column.multiple,
        )?.name ??
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
    if (nextType === "gallery") {
      return {
        type: nextType,
        card_cover: ["cover", "icon", "title"],
        cover_fit: "cover",
        cover_aspect: "16/9",
        size: "medium",
      };
    }
    return { type: nextType };
  }

  function viewTypeDefaultName(type: ViewType) {
    const names: Record<ViewType, string> = {
      table: "Table",
      board: "Board",
      calendar: "Calendar",
      list: "List",
      gallery: "Gallery",
    };
    return names[type];
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
    const defaultTemplateSlug = schema?.templates?.default ?? null;
    if (defaultTemplateSlug) {
      try {
        const created = await instantiateTemplate({
          spacePath,
          collectionPath,
          templateSlug: defaultTemplateSlug,
          parentDir: collectionPath,
          initialTitle: title,
          forceFolder: asFolder,
          contextualDefaults: contextualDefaults ?? null,
          projectPath,
        });
        setEntriesVersion((version) => version + 1);
        await reloadTreeParent(spaceId, collectionPath);
        if (openAfterCreate) {
          openDocument(created.path, spaceId);
        }
        return created;
      } catch (error) {
        if (!isMissingTemplateError(error)) throw error;
        toast.warning(m.collection_default_template_missing());
        console.warn("Failed to instantiate default template:", error);
      }
    }

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
        filePath: created.path,
        projectPath: projectPath ?? null,
      });
    }
    setEntriesVersion((version) => version + 1);
    await reloadTreeParent(spaceId, collectionPath);
    if (openAfterCreate) {
      openDocument(nextEntry.path, spaceId);
    }
    return nextEntry;
  }

  async function loadTemplatesForMenu() {
    return listTemplates({ spacePath, collectionPath });
  }

  async function createTemplateForMenu(kind: TemplateKind) {
    const path = await createTemplateApi({
      spacePath,
      collectionPath,
      title: m.collection_new_template(),
      kind,
      projectPath,
    });
    const entry = await readTemplateEntry({ spacePath, path });
    setPeekTarget({
      entry,
      nested: kind === "nestedCollection",
      template: {
        slug: entryTemplateSlug(collectionPath, entry.path),
        collectionPath,
        isDefault: false,
      },
    });
  }

  async function instantiateTemplateForMenu(
    template: TemplateInfo,
    forceFolder: boolean,
  ) {
    const created = await instantiateTemplate({
      spacePath,
      collectionPath,
      templateSlug: template.slug,
      parentDir: collectionPath,
      initialTitle: null,
      forceFolder,
      contextualDefaults: null,
      projectPath,
    });
    setEntriesVersion((version) => version + 1);
    await reloadTreeParent(spaceId, collectionPath);
    openDocument(created.path, spaceId);
  }

  async function editTemplate(template: TemplateInfo) {
    const path = templateHeadPath(collectionPath, template);
    const entry = await readTemplateEntry({ spacePath, path });
    setPeekTarget({
      entry,
      nested: template.kind === "nestedCollection",
      template: {
        slug: template.slug,
        collectionPath,
        isDefault: Boolean(template.isDefault ?? template.is_default),
      },
    });
  }

  async function setDefaultTemplateForMenu(slug: string | null) {
    const next = await setDefaultTemplate({
      spacePath,
      collectionPath,
      templateSlug: slug,
      projectPath,
    });
    setSchema(normalizeSchema(next));
    setPeekTarget((current) =>
      current?.template
        ? {
            ...current,
            template: {
              ...current.template,
              isDefault: slug === current.template.slug,
            },
          }
        : current,
    );
  }

  async function duplicateTemplateForMenu(template: TemplateInfo) {
    await duplicateTemplateApi({
      spacePath,
      collectionPath,
      templateSlug: template.slug,
      projectPath,
    });
  }

  async function deleteTemplateForMenu(template: TemplateInfo) {
    await deleteTemplate({
      spacePath,
      collectionPath,
      templateSlug: template.slug,
      projectPath,
    });
    if (schema?.templates?.default === template.slug) {
      toast.warning(m.collection_default_template_missing());
    }
  }

  async function reorderTemplatesForMenu(slugs: string[]) {
    const next = await reorderTemplates({
      spacePath,
      collectionPath,
      newOrder: slugs,
      projectPath,
    });
    setSchema(normalizeSchema(next));
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

  async function duplicateRow(entryToDuplicate: Entry) {
    const duplicated = await invoke<Entry>("duplicate_entry", {
      space: spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    setEntriesVersion((version) => version + 1);
    await reloadTreeParent(spaceId, collectionPath);
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
    removeTreePath(spaceId, entryToDelete.path);
    await reloadTreePathParent(spaceId, entryToDelete.path);
  }

  async function duplicateDetailEntry(entryToDuplicate: Entry) {
    const duplicated = await invoke<Entry>("duplicate_entry", {
      space: spacePath,
      filePath: entryToDuplicate.path,
      projectPath: projectPath ?? null,
    });
    await reloadTreePathParent(spaceId, duplicated.path);
    openDocument(duplicated.path, spaceId);
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

  const propertiesSchema =
    parentSchema &&
    (parentSchema.collectionRootPath ?? parentSchema.collection_root_path) !==
      collectionPath
      ? { ...parentSchema, schema: normalizeSchema(parentSchema.schema) }
      : null;
  const hasHeaderProperties = Boolean(
    propertiesSchema &&
    propertiesSchema.schema.columns.length > 0 &&
    entry,
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
        onConvertedEntry={(nextEntry, nested) => {
          setPeekTarget({ entry: nextEntry, nested });
          setEntriesVersion((version) => version + 1);
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
        onDuplicateTemplate={async (entryToDuplicate) => {
          const slug = entryTemplateSlug(collectionPath, entryToDuplicate.path);
          const duplicatePath = normalizeEntryPath(entryToDuplicate.path);
          await duplicateTemplateForMenu({
            slug,
            title: entryToDuplicate.meta.title,
            icon: entryToDuplicate.meta.icon,
            kind: duplicatePath.toLowerCase().includes("/schema.yaml")
              ? "nestedCollection"
              : duplicatePath.toLowerCase().endsWith("/readme.md")
                ? "folder"
                : "leaf",
          });
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

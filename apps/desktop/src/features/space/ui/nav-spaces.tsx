import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as m from "@/paraglide/messages.js";
import { toast } from "sonner";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronRight,
  CloudOff,
  Database,
  Ellipsis,
  FilePlus,
  FolderDown,
  FolderPlus,
  Loader2,
  Plus,
  Save,
  Settings,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { createFolder } from "@/platform/entries/entries-api";
import {
  cloneMissingSpace,
  getSpaceConfig,
  removeMissingSpace,
  saveSpaceConfig,
} from "@/platform/space/space-api";
import { useSpaceStore } from "../model";
import { useEntrySelectionStore } from "@/features/entry";
import type { TreeNode } from "@/features/entry";
import type { LfsState, SpaceInfo } from "../model";
import { listen } from "@/platform/native/events";
import type { CloneProgress } from "@/features/git";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CreateSpaceDialog } from "./create-space-dialog";
import { createCollection } from "@/features/collection";
import { SortableFileTree } from "./sortable-file-tree";
import { FileTreeItem } from "./file-tree-item";
import { GitIndicatorIcon, SpaceGitWatcher } from "@/features/git";
import { useGitStore } from "@/features/git";
import { Progress } from "@/components/ui/progress";
import { commitAllSpace } from "@/features/git";
import { cn } from "@/shared/lib/utils";

interface NavSpacesProps {
  onActivateContent: () => void;
  onOpenSpaceSettings: (spacePath: string) => void;
}

type ScopeTarget = { id: string; path: string };

function visibleScopeChildren(tree: TreeNode[]): TreeNode[] {
  return tree.filter((node) => node.path.toLowerCase() !== "readme.md");
}

function hasScopeReadme(tree: TreeNode[]): boolean {
  return tree.some((node) => node.path.toLowerCase() === "readme.md");
}

export function NavSpaces({
  onActivateContent,
  onOpenSpaceSettings,
}: NavSpacesProps) {
  const {
    activeRootId,
    activeRootName,
    activeRootIcon,
    activeRootPath,
    spaces,
    activeSpaceId,
    fileTrees,
    openSpace,
    clearActiveSpace,
    deleteSpace,
    createEntry,
    refreshTree,
    loadSpaces,
    reorderSpaces,
  } = useSpaceStore();
  const {
    activeDocument,
    activeDocumentSpaceId,
    openDocument,
    openScopeHome,
  } = useEntrySelectionStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [rootOpen, setRootOpen] = useState(true);
  const editRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  useEffect(() => {
    if (editingSpaceId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingSpaceId]);

  useEffect(() => {
    if (!activeRootPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<{ projectPath: string; spaceId: string | null; state: LfsState }>(
      "space:lfs_state_changed",
      (event) => {
        if (cancelled) return;
        if (event.payload.projectPath !== activeRootPath) return;
        const targetId = event.payload.spaceId;
        if (!targetId) return;
        useSpaceStore.setState((s) => ({
          spaces: s.spaces.map((ws) =>
            ws.id === targetId ? { ...ws, lfsState: event.payload.state } : ws,
          ),
        }));
      },
    ).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activeRootPath]);

  if (!activeRootId || !activeRootPath) return null;

  const rootId = activeRootId;
  const rootPath = activeRootPath;
  const rootTree = fileTrees[rootId] ?? [];
  const rootHomeActive =
    activeDocumentSpaceId === rootId &&
    (!activeDocument || activeDocument.toLowerCase() === "readme.md");
  const childSpaceIds = spaces.map((space) => space.id);

  function openHomeForScope(spaceId: string, tree: TreeNode[]) {
    if (hasScopeReadme(tree)) {
      openDocument("README.md", spaceId);
    } else {
      openScopeHome(spaceId);
    }
  }

  function handleOpenRootHome() {
    onActivateContent();
    clearActiveSpace();
    openHomeForScope(
      rootId,
      useSpaceStore.getState().fileTrees[rootId] ?? rootTree,
    );
  }

  async function handleOpenSpaceHome(ws: SpaceInfo) {
    onActivateContent();
    await openSpace(ws.id);
    const tree = useSpaceStore.getState().fileTrees[ws.id] ?? [];
    openHomeForScope(ws.id, tree);
  }

  async function handleRenameSpace() {
    const ws = spaces.find((w) => w.id === editingSpaceId);
    if (!ws || !editValue.trim() || editValue.trim() === ws.name) {
      setEditingSpaceId(null);
      return;
    }
    try {
      const cfg = await getSpaceConfig(ws.path);
      await saveSpaceConfig(
        ws.path,
        { ...cfg, name: editValue.trim() },
        rootPath,
      );
      useSpaceStore.setState({
        spaces: useSpaceStore.getState().spaces.map((w) =>
          w.id === editingSpaceId ? { ...w, name: editValue.trim() } : w,
        ),
      });
    } catch (err) {
      console.error("Failed to rename space:", err);
      toast.error(m.toast_error());
    }
    setEditingSpaceId(null);
  }

  async function handleNewPage(scope: ScopeTarget) {
    try {
      const entry = await createEntry(scope.path, "Untitled");
      if (entry) {
        onActivateContent();
        openDocument(entry.path, scope.id);
      }
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewFolder(scope: ScopeTarget) {
    try {
      await createFolder({
        space: scope.path,
        parentPath: null,
        name: m.space_new_folder(),
        projectPath: rootPath,
      });
      await refreshTree(scope.id);
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewCollection(scope: ScopeTarget) {
    try {
      const entry = await createCollection({
        spacePath: scope.path,
        title: m.editor_untitled(),
        projectPath: activeRootPath,
      });
      await refreshTree(scope.id);
      onActivateContent();
      openDocument(entry.path, scope.id);
    } catch (err) {
      console.error("Failed to create collection:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDeleteSpace(spaceId: string) {
    try {
      await deleteSpace(rootPath, spaceId, deleteFiles);
    } catch (err) {
      console.error("Failed to delete space:", err);
      toast.error(m.toast_error());
    }
    setDeleteTarget(null);
    setDeleteFiles(false);
  }

  async function handleCloneMissing(spaceId: string, spacePath: string) {
    const git = useGitStore.getState();
    git.setCloning(spacePath, { phase: "Starting", percent: 0 });

    const unlisten = await listen<CloneProgress>("clone:progress", (event) => {
      if (event.payload.spacePath !== spacePath) return;
      useGitStore.getState().setCloning(spacePath, {
        phase: event.payload.phase,
        percent: event.payload.percent,
      });
    });

    try {
      await cloneMissingSpace(rootPath, spaceId);
      await loadSpaces(rootPath);
      git.setCloning(spacePath, null);
    } catch (err) {
      console.error("clone_missing_space failed:", err);
      const message =
        typeof err === "string" ? err : ((err as Error)?.message ?? "error");
      git.setCloning(spacePath, {
        phase: m.git_clone_failed(),
        percent: 0,
        error: message,
      });
      toast.error(m.git_clone_failed());
      window.setTimeout(
        () => useGitStore.getState().setCloning(spacePath, null),
        6000,
      );
    } finally {
      unlisten();
    }
  }

  async function handleRemoveBroken(spaceId: string) {
    try {
      await removeMissingSpace(rootPath, spaceId);
      await loadSpaces(rootPath);
    } catch (err) {
      console.error("remove_missing_space failed:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleSpaceDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = spaces.findIndex((space) => space.id === active.id);
    const newIndex = spaces.findIndex((space) => space.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const nextSpaces = arrayMove(spaces, oldIndex, newIndex);
    try {
      await reorderSpaces(nextSpaces.map((space) => space.id));
    } catch (err) {
      console.error("Failed to reorder spaces:", err);
      toast.error(m.toast_error());
    }
  }

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{m.sidebar_content()}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <RootScopeRow
              active={rootHomeActive}
              icon={activeRootIcon}
              name={activeRootName}
              open={rootOpen}
              tree={visibleScopeChildren(rootTree)}
              onOpenChange={setRootOpen}
              onOpenHome={handleOpenRootHome}
              onNewPage={() =>
                handleNewPage({ id: rootId, path: rootPath })
              }
              onNewFolder={() =>
                handleNewFolder({ id: rootId, path: rootPath })
              }
              onNewCollection={() =>
                handleNewCollection({ id: rootId, path: rootPath })
              }
              onAddSpace={() => setCreateDialogOpen(true)}
              onProjectSettings={() => onOpenSpaceSettings(rootPath)}
              spaceId={rootId}
              rootPath={rootPath}
            />
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleSpaceDragEnd}
            >
              <SortableContext
                items={childSpaceIds}
                strategy={verticalListSortingStrategy}
              >
                {spaces.map((ws) => {
                  const tree = fileTrees[ws.id] ?? [];
                  const isActive =
                    activeDocumentSpaceId === ws.id &&
                    (!activeDocument ||
                      activeDocument.toLowerCase() === "readme.md");
                  return (
                    <SpaceRow
                      key={ws.id}
                      ws={ws}
                      isActive={isActive}
                      tree={visibleScopeChildren(tree)}
                      editingSpaceId={editingSpaceId}
                      editValue={editValue}
                      setEditValue={setEditValue}
                      setEditingSpaceId={setEditingSpaceId}
                      handleRenameSpace={handleRenameSpace}
                      handleNewPage={handleNewPage}
                      handleNewFolder={handleNewFolder}
                      handleNewCollection={handleNewCollection}
                      openSpaceSettings={onOpenSpaceSettings}
                      openScopeHome={handleOpenSpaceHome}
                      onActivateContent={onActivateContent}
                      setDeleteTarget={setDeleteTarget}
                      handleCloneMissing={handleCloneMissing}
                      handleRemoveBroken={handleRemoveBroken}
                      editRef={editRef}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <CreateSpaceDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteFiles(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.space_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.space_delete_description()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-center gap-2 py-2">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <span className="text-sm text-destructive">
              {m.space_delete_files()}
            </span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                deleteTarget && handleDeleteSpace(deleteTarget.id)
              }
            >
              {m.space_delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface RootScopeRowProps {
  active: boolean;
  icon: string | null;
  name: string | null;
  open: boolean;
  tree: TreeNode[];
  onOpenChange: (open: boolean) => void;
  onOpenHome: () => void;
  onNewPage: () => void;
  onNewFolder: () => void;
  onNewCollection: () => void;
  onAddSpace: () => void;
  onProjectSettings: () => void;
  spaceId: string;
  rootPath: string;
}

function RootScopeRow({
  active,
  icon,
  name,
  open,
  tree,
  onOpenChange,
  onOpenHome,
  onNewPage,
  onNewFolder,
  onNewCollection,
  onAddSpace,
  onProjectSettings,
  spaceId,
  rootPath,
}: RootScopeRowProps) {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={active} onClick={onOpenHome}>
          <span>{icon || "\u{1F4C1}"}</span>
          <span className="flex-1 truncate">{name || "Project"}</span>
          <span className="ml-auto flex items-center gap-1">
            <GitIndicatorIcon spacePath={rootPath} />
          </span>
        </SidebarMenuButton>
        <CollapsibleTrigger asChild>
          <SidebarMenuAction
            className="left-2 bg-sidebar-accent text-sidebar-accent-foreground data-[state=open]:rotate-90"
            showOnHover
          >
            <ChevronRight />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover>
              <Ellipsis />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onClick={onNewPage}>
              <FilePlus />
              {m.space_new_page()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onNewFolder}>
              <FolderPlus />
              {m.space_new_folder()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onNewCollection}>
              <Database />
              {m.collection_new()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onAddSpace}>
              <Plus />
              {m.sidebar_add_space()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onProjectSettings}>
              <Settings />
              {m.sidebar_project_settings()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          <SortableFileTree spaceId={spaceId} tree={tree}>
            <SidebarMenuSub className="ml-4 border-l-0 pl-2">
              {tree.map((node) => (
                <FileTreeItem key={node.path} node={node} spaceId={spaceId} />
              ))}
            </SidebarMenuSub>
          </SortableFileTree>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

interface SpaceRowProps {
  ws: SpaceInfo;
  isActive: boolean;
  tree: TreeNode[];
  editingSpaceId: string | null;
  editValue: string;
  setEditValue: (v: string) => void;
  setEditingSpaceId: (id: string | null) => void;
  handleRenameSpace: () => void;
  handleNewPage: (scope: ScopeTarget) => void;
  handleNewFolder: (scope: ScopeTarget) => void;
  handleNewCollection: (scope: ScopeTarget) => void;
  openSpaceSettings: (path: string) => void;
  openScopeHome: (ws: SpaceInfo) => void;
  onActivateContent: () => void;
  setDeleteTarget: (t: { id: string; name: string }) => void;
  handleCloneMissing: (spaceId: string, spacePath: string) => void;
  handleRemoveBroken: (spaceId: string) => void;
  editRef: RefObject<HTMLInputElement | null>;
}

function SpaceRow({
  ws,
  isActive,
  tree,
  editingSpaceId,
  editValue,
  setEditValue,
  setEditingSpaceId,
  handleRenameSpace,
  handleNewPage,
  handleNewFolder,
  handleNewCollection,
  openSpaceSettings,
  openScopeHome,
  setDeleteTarget,
  handleCloneMissing,
  handleRemoveBroken,
  editRef,
}: SpaceRowProps) {
  const cloning = useGitStore((s) => s.cloning[ws.path]);
  const dirty = useGitStore(
    (s) =>
      !!(s.statuses[ws.path]?.hasStaged || s.statuses[ws.path]?.hasUnstaged),
  );
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ws.id });
  const sortableStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const sortableClassName = cn(
    "cursor-grab active:cursor-grabbing",
    isDragging && "opacity-60",
  );
  const scope = { id: ws.id, path: ws.path };

  if (ws.status === "missing" || ws.status === "broken") {
    return (
      <SidebarMenuItem
        ref={setNodeRef}
        style={sortableStyle}
        className={sortableClassName}
        {...attributes}
        {...listeners}
      >
        <SidebarMenuButton disabled className="opacity-50">
          <span>{ws.icon || "\u{1F4C2}"}</span>
          <span className="flex-1 truncate text-muted-foreground">
            {ws.name}
          </span>
        </SidebarMenuButton>
        {cloning && (
          <div className="px-2 pb-1">
            <Progress value={cloning.percent} className="h-1" />
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {cloning.error
                ? cloning.error
                : `${cloning.phase} ${cloning.percent}%`}
            </p>
          </div>
        )}
        {ws.status === "missing" && !cloning && (
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuAction
                onClick={() => handleCloneMissing(ws.id, ws.path)}
              >
                <FolderDown />
              </SidebarMenuAction>
            </TooltipTrigger>
            <TooltipContent side="right">
              {m.space_clone_missing()}
            </TooltipContent>
          </Tooltip>
        )}
        {ws.status === "missing" && cloning && (
          <SidebarMenuAction disabled>
            <Loader2 className="animate-spin" />
          </SidebarMenuAction>
        )}
        {ws.status === "broken" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarMenuAction onClick={() => handleRemoveBroken(ws.id)}>
                <X />
              </SidebarMenuAction>
            </TooltipTrigger>
            <TooltipContent side="right">{m.space_remove_broken()}</TooltipContent>
          </Tooltip>
        )}
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible asChild defaultOpen={isActive}>
      <SidebarMenuItem
        ref={setNodeRef}
        style={sortableStyle}
        className={sortableClassName}
        {...attributes}
        {...listeners}
      >
        <SpaceGitWatcher spacePath={ws.path} />
        <SidebarMenuButton
          isActive={isActive}
          disabled={!!cloning}
          onClick={() => {
            if (editingSpaceId !== ws.id) openScopeHome(ws);
          }}
          onDoubleClick={() => {
            setEditingSpaceId(ws.id);
            setEditValue(ws.name);
          }}
        >
          <span>{ws.icon}</span>
          {editingSpaceId === ws.id ? (
            <input
              ref={editRef}
              className="w-full truncate border-b border-primary bg-transparent text-sm outline-none"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRenameSpace}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleRenameSpace();
                } else if (e.key === "Escape") setEditingSpaceId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate">{ws.name}</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <LfsIndicatorIcon lfsState={ws.lfsState} />
            <GitIndicatorIcon spacePath={ws.path} />
          </span>
        </SidebarMenuButton>
        {cloning && (
          <div className="px-2 pb-1">
            <Progress value={cloning.percent} className="h-1" />
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {cloning.error
                ? cloning.error
                : `${cloning.phase} ${cloning.percent}%`}
            </p>
          </div>
        )}
        {!cloning && ws.lfsState === "pulling" && (
          <div className="flex items-center gap-1.5 px-2 pb-1">
            <Loader2 className="animate-spin text-muted-foreground" />
            <p className="truncate text-[10px] text-muted-foreground">
              {m.storage_repair_lfs_pulling()}
            </p>
          </div>
        )}
        <CollapsibleTrigger asChild>
          <SidebarMenuAction
            className="left-2 bg-sidebar-accent text-sidebar-accent-foreground data-[state=open]:rotate-90"
            showOnHover
          >
            <ChevronRight />
          </SidebarMenuAction>
        </CollapsibleTrigger>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover>
              <Ellipsis />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onClick={() => handleNewPage(scope)}>
              <FilePlus />
              {m.space_new_page()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNewFolder(scope)}>
              <FolderPlus />
              {m.space_new_folder()}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNewCollection(scope)}>
              <Database />
              {m.collection_new()}
            </DropdownMenuItem>
            {dirty && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() =>
                    commitAllSpace(
                      ws.path,
                      useSpaceStore.getState().activeRootPath ?? undefined,
                    )
                  }
                >
                  <Save />
                  {m.git_save_all()}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openSpaceSettings(ws.path)}>
              <Settings />
              {m.space_settings()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setEditingSpaceId(ws.id);
                setEditValue(ws.name);
              }}
            >
              <Pencil />
              {m.space_rename()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setDeleteTarget({ id: ws.id, name: ws.name })}
            >
              <Trash2 />
              {m.space_delete()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          <SortableFileTree spaceId={ws.id} tree={tree}>
            <SidebarMenuSub className="ml-4 border-l-0 pl-2">
              {tree.map((node) => (
                <FileTreeItem key={node.path} node={node} spaceId={ws.id} />
              ))}
            </SidebarMenuSub>
          </SortableFileTree>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function LfsIndicatorIcon({ lfsState }: { lfsState: LfsState }) {
  if (lfsState !== "missing-creds") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <CloudOff className="text-destructive" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {m.storage_lfs_banner_missing_remote_title()}
      </TooltipContent>
    </Tooltip>
  );
}

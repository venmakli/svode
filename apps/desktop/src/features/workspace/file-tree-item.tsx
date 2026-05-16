import { useContext, useState, useRef, useEffect, type KeyboardEvent, type ReactElement } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronRight, Database, Ellipsis, FileText, FilePlus, FolderOpen, FolderPlus, GripVertical, FileSymlink, Pencil, Trash2 } from "lucide-react";
import { useLayoutStore } from "@/stores/layout";
import { useEditorStore } from "@/stores/editor";
import { useSpaceStore } from "@/stores/space";
import type { TreeNode } from "@/types/space";
import { TreeDndContext } from "./sortable-file-tree";
import { TreeDropIndicator } from "./tree-drop-indicator";
import { isDescendantOf } from "./tree-dnd-utilities";
import { FileGitIndicatorIcon } from "./git-status-indicator";
import { selectFileIndicator, useGitStore } from "@/stores/git";

interface FileTreeItemProps {
  node: TreeNode;
  spaceId: string;
}

interface BacklinkInfo {
  sourceSpaceId: string | null;
  sourcePath: string;
  linkCount: number;
}

interface Entry {
  path: string;
  meta: { id: string };
}

/** Bare folder = directory without readme.md (path doesn't end with .md) */
function isBareFolder(node: TreeNode): boolean {
  return !node.path.endsWith(".md");
}

export function FileTreeItem({ node, spaceId }: FileTreeItemProps) {
  const { openDocument, activeDocument } = useLayoutStore();
  const { unsavedChanges, aiModified } = useEditorStore();
  const { expandedPaths, toggleExpanded, refreshTree, spaces, rootSpaces, activeSpaceId, activeRootId, activeRootPath } =
    useSpaceStore();

  const bareFolder = isBareFolder(node);
  const isActive = !bareFolder && activeDocument === node.path;
  const isUnsaved = !!unsavedChanges[node.path];
  const isAiModified = !!aiModified[node.path];
  // Conflict always wins — if the file has merge markers, we must show ⚠
  // even if the user is mid-edit locally.
  const spaceForGit = spaces.find((w) => w.id === spaceId)
    ?? rootSpaces.find((w) => w.id === spaceId);
  const fileGitState = useGitStore((s) =>
    spaceForGit ? selectFileIndicator(s, spaceForGit.path, node.path) : "clean",
  );
  const inConflict = fileGitState === "conflict";
  const showDot = !inConflict && (isUnsaved || isAiModified);

  const expanded = expandedPaths[spaceId]?.includes(node.path) ?? false;

  const { activeId, activeFolderPath, overId, projection, flatItemsMap } = useContext(TreeDndContext);

  // Disable sortable for children of the currently dragged folder
  const isChildOfDragged = !!activeFolderPath && isDescendantOf(node.path, activeFolderPath);

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: node.path, disabled: isChildOfDragged });
  const isOver = activeId !== null && overId === node.path;
  // Use projection.overPath as source of truth for nest highlight target
  const isProjectionTarget = activeId !== null && projection?.overPath === node.path;
  const myDepth = flatItemsMap.get(node.path)?.depth ?? 0;

  const style = {
    opacity: isDragging ? 0.4 : undefined,
  };

  const space = spaceForGit;

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    backlinks: BacklinkInfo[];
  }>({ open: false, backlinks: [] });

  function backlinkLabel(backlink: BacklinkInfo): string {
    if (!backlink.sourceSpaceId) return backlink.sourcePath;
    const sourceSpace = [...rootSpaces, ...spaces].find(
      (item) => item.id === backlink.sourceSpaceId,
    );
    return sourceSpace
      ? `${sourceSpace.name} · ${backlink.sourcePath}`
      : backlink.sourcePath;
  }

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [isEditing]);

  function handleStartRename() {
    setEditValue(node.title);
    setIsEditing(true);
  }

  async function handleRenameSubmit() {
    const newName = editValue.trim();
    if (!space || !newName || newName === node.title) {
      setIsEditing(false);
      return;
    }
    try {
      if (bareFolder) {
        // Bare folder: rename directory on disk
        const parent = node.path.includes("/")
          ? node.path.substring(0, node.path.lastIndexOf("/"))
          : "";
        const newPath = parent ? `${parent}/${newName}` : newName;
        const modifiedFiles = await invoke<string[]>("rename_entry", {
          space: space.path,
          from: node.path,
          to: newPath,
          projectPath: activeRootPath,
        });
        // Backlinks files: invalidate Plate cache (markStale) + suppress
        // watcher so it doesn't re-mark them as aiModified (no blue dot —
        // the user just initiated this rename, no review needed).
        if (modifiedFiles.length > 0) {
          const editor = useEditorStore.getState();
          for (const f of modifiedFiles) editor.markStale(f);
          editor.suppressPaths(modifiedFiles);
        }
      } else {
        // Title-edit only: file rename + backlinks are deferred to ⌘S (unified with editor-title-edit).
        const entry = await invoke<{ meta: { id: string; icon: string | null; extra: Record<string, unknown> }; body: string }>(
          "read_entry",
          { space: space.path, path: node.path },
        );
        const result = await invoke<{ new_path: string | null }>("write_entry", {
          space: space.path,
          path: node.path,
          content: entry.body,
          title: newName,
          icon: entry.meta.icon,
          extra: entry.meta.extra && Object.keys(entry.meta.extra).length > 0 ? entry.meta.extra : null,
          existingId: entry.meta.id ?? null,
          skipRename: true,
        });
        if (activeDocument === node.path) {
          useEditorStore.getState().requestRename(node.path, newName, result.new_path);
        }
      }
      await refreshTree(spaceId);
    } catch (err) {
      console.error("Failed to rename:", err);
      toast.error(m.toast_error());
    }
    setIsEditing(false);
  }

  function handleRenameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  }

  function handleDocumentClick() {
    if (node.has_schema) {
      const isRootWorkspace = spaceId === activeRootId;
      if (isRootWorkspace && activeSpaceId) {
        useSpaceStore.getState().clearActiveSpace();
      } else if (!isRootWorkspace && activeSpaceId !== spaceId) {
        useSpaceStore.getState().openSpace(spaceId);
      }
      openDocument(node.path, spaceId);
      return;
    }
    if (bareFolder) {
      toggleExpanded(spaceId, node.path);
      return;
    }
    const isRootWorkspace = spaceId === activeRootId;
    if (isRootWorkspace && activeSpaceId) {
      useSpaceStore.getState().clearActiveSpace();
    } else if (!isRootWorkspace && activeSpaceId !== spaceId) {
      useSpaceStore.getState().openSpace(spaceId);
    }
    openDocument(node.path, spaceId);
  }

  async function handleNewPage() {
    if (!space) return;
    try {
      let parentPath: string;
      let parentNodePath: string;
      if (bareFolder) {
        // Bare folder — already a directory, just use the path
        parentPath = node.path;
        parentNodePath = node.path;
      } else if (node.children.length > 0) {
        // Document folder — parent is the folder path
        parentPath = node.path.replace(/\/readme\.md$/i, "");
        parentNodePath = node.path;
      } else {
        // Simple file — nest it first, then create child
        const newPath = await invoke<string>("nest_entry", {
          space: space.path,
          path: node.path,
          projectPath: activeRootPath,
        });
        parentPath = newPath.replace(/\/readme\.md$/i, "");
        parentNodePath = newPath; // path changed after nest
      }
      // Create the sub-page
      const entry = await invoke<{ path: string }>("create_entry", {
        space: space.path,
        parentPath,
        title: "Untitled",
        projectPath: activeRootPath,
      });
      await refreshTree(spaceId);
      // Expand the parent so the new child is visible
      if (!expandedPaths[spaceId]?.includes(parentNodePath)) {
        toggleExpanded(spaceId, parentNodePath);
      }
      openDocument(entry.path, spaceId);
      toast.success(m.toast_page_created());
    } catch (err) {
      console.error("Failed to create page:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleMakeDocument() {
    if (!space || !bareFolder) return;
    try {
      // Create a document inside the bare folder, then rename to readme.md
      const entry = await invoke<{ path: string }>("create_entry", {
        space: space.path,
        parentPath: node.path,
        title: node.title,
        projectPath: activeRootPath,
      });
      const readmePath = `${node.path}/README.md`;
      if (entry.path !== readmePath) {
        await invoke("rename_entry", {
          space: space.path,
          from: entry.path,
          to: readmePath,
          projectPath: activeRootPath,
        });
      }
      await refreshTree(spaceId);
      openDocument(readmePath, spaceId);
    } catch (err) {
      console.error("Failed to make document:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleMakeCollection() {
    if (!space || node.has_schema) return;
    try {
      if (bareFolder) {
        const entry = await invoke<Entry>("convert_bare_folder_to_collection", {
          space: space.path,
          folderPath: node.path,
          projectPath: activeRootPath,
        });
        await refreshTree(spaceId);
        openDocument(entry.path, spaceId);
        return;
      }

      const entry = await invoke<Entry>("read_entry", {
        space: space.path,
        path: node.path,
      });
      let readmeEntry = entry;
      if (!node.path.toLowerCase().endsWith("/readme.md")) {
        readmeEntry = await invoke<Entry>("convert_entry_to_folder", {
          space: space.path,
          entryId: entry.meta.id,
          projectPath: activeRootPath,
        });
      }
      await invoke<string>("convert_entry_to_nested_collection", {
        space: space.path,
        entryId: readmeEntry.meta.id,
        projectPath: activeRootPath,
      });
      await refreshTree(spaceId);
      openDocument(readmeEntry.path, spaceId);
    } catch (err) {
      console.error("Failed to make collection:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleNewFolder() {
    if (!space) return;
    try {
      let parentPath: string;
      let parentNodePath: string;
      if (bareFolder) {
        parentPath = node.path;
        parentNodePath = node.path;
      } else if (node.children.length > 0) {
        parentPath = node.path.replace(/\/readme\.md$/i, "");
        parentNodePath = node.path;
      } else {
        // Simple file — nest it first, then create folder inside
        const newPath = await invoke<string>("nest_entry", {
          space: space.path,
          path: node.path,
          projectPath: activeRootPath,
        });
        parentPath = newPath.replace(/\/readme\.md$/i, "");
        parentNodePath = newPath;
      }
      await invoke<string>("create_folder", {
        space: space.path,
        parentPath,
        name: m.space_new_folder(),
        projectPath: activeRootPath,
      });
      await refreshTree(spaceId);
      if (!expandedPaths[spaceId]?.includes(parentNodePath)) {
        toggleExpanded(spaceId, parentNodePath);
      }
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(m.toast_error());
    }
  }

  async function handleDeleteRequest() {
    if (!space) return;
    try {
      const backlinks = await invoke<BacklinkInfo[]>("get_backlinks", {
        space: space.path,
        targetPath: node.path,
        projectPath: activeRootPath ?? null,
      });
      setDeleteDialog({ open: true, backlinks });
    } catch {
      // If backlinks check fails, show dialog anyway without backlinks
      setDeleteDialog({ open: true, backlinks: [] });
    }
  }

  async function handleDeleteConfirm() {
    if (!space) return;
    setDeleteDialog({ open: false, backlinks: [] });
    try {
      await invoke("delete_entry", {
        space: space.path,
        path: node.path,
        projectPath: activeRootPath,
      });
      await refreshTree(spaceId);
    } catch (err) {
      console.error("Failed to delete entry:", err);
      toast.error(m.toast_error());
    }
  }

  const iconElement = node.icon ? (
    <span className="h-4 w-4 shrink-0 text-center leading-4">{node.icon}</span>
  ) : node.has_schema ? (
    <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : bareFolder ? (
    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="h-4 w-4 shrink-0" />
  );

  // Phase 4 model: disk = source of truth, "in-memory unsaved" no longer
  // exists as a distinct state. Both unsaved (autosave pending or post-write
  // pre-commit) and ai-modified render as the same grey dot the git
  // indicator uses, so the bridge from `isUnsaved` (cleared on commit) to
  // `fileGitState === "dirty"` (set after watcher refresh) is invisible —
  // no more red↔grey flicker.
  const dot = showDot ? (
    <span
      className={`ml-auto shrink-0 text-xs ${isAiModified ? "text-blue-500" : "text-muted-foreground"}`}
      title={isAiModified ? "Modified externally" : "Uncommitted changes"}
    >
      ●
    </span>
  ) : space ? (
    <span className="ml-auto shrink-0 flex items-center">
      <FileGitIndicatorIcon
        spacePath={space.path}
        filePath={node.path}
      />
    </span>
  ) : null;

  const titleElement = isEditing ? (
    <input
      ref={editRef}
      className="truncate bg-transparent outline-none text-sm w-full border-b border-primary"
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={handleRenameSubmit}
      onKeyDown={handleRenameKeyDown}
      onClick={(e) => e.stopPropagation()}
    />
  ) : (
    <span className="truncate">{node.title}</span>
  );

  const hasDescription = !bareFolder && !!node.description?.trim();

  const dragHandle = (
    <button
      className="absolute -left-4 top-0 z-10 flex h-7 w-4 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100 cursor-grab active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-3 w-3" />
    </button>
  );

  const contextMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-7 w-5 shrink-0 items-center justify-center opacity-0 group-hover/tree-item:opacity-50 hover:!opacity-100">
          <Ellipsis className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        {bareFolder && !node.has_schema && (
          <DropdownMenuItem onClick={handleMakeDocument}>
            <FileSymlink className="mr-2 h-4 w-4" />
            {m.space_make_document()}
          </DropdownMenuItem>
        )}
        {!node.has_schema && (
          <DropdownMenuItem onClick={handleMakeCollection}>
            <Database className="mr-2 h-4 w-4" />
            {m.collection_make()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={handleNewPage}>
          <FilePlus className="mr-2 h-4 w-4" />
          {m.space_new_page()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleNewFolder}>
          <FolderPlus className="mr-2 h-4 w-4" />
          {m.space_new_folder()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleStartRename}>
          <Pencil className="mr-2 h-4 w-4" />
          {m.space_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={handleDeleteRequest}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {m.space_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Relative depth: how much deeper/shallower the projected position is
  // compared to this item's actual depth
  const relativeDepth = projection ? projection.depth - myDepth : 0;
  const isNestTarget = isProjectionTarget && projection?.type === "child";
  const dropIndicator =
    isOver && projection && projection.type !== "child" ? (
      <TreeDropIndicator type={projection.type} relativeDepth={relativeDepth} />
    ) : null;

  const nestHighlight = isNestTarget ? "bg-sidebar-accent ring-1 ring-sidebar-primary/30 rounded-md" : "";

  const deleteConfirmDialog = (
    <AlertDialog
      open={deleteDialog.open}
      onOpenChange={(open) => {
        if (!open) setDeleteDialog({ open: false, backlinks: [] });
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.file_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.file_delete_description()}
            {deleteDialog.backlinks.length > 0 && (
              <>
                <br /><br />
                {m.file_delete_has_backlinks()}
                <ul className="mt-2 list-disc pl-5">
                  {deleteDialog.backlinks.map((bl) => (
                    <li
                      key={`${bl.sourceSpaceId ?? "root"}:${bl.sourcePath}`}
                      className="text-foreground"
                    >
                      {backlinkLabel(bl)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.file_delete_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={handleDeleteConfirm}
          >
            {m.file_delete_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  function withDescriptionTooltip(element: ReactElement) {
    if (!hasDescription) return element;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{element}</TooltipTrigger>
        <TooltipContent side="right" className="flex flex-col items-start gap-0.5">
          <span>{node.title}</span>
          <span className="text-xs text-muted-foreground">
            {node.description}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Leaf node (simple file or empty bare folder with no children)
  if (node.children.length === 0 && !bareFolder) {
    return (
      <>
        <SidebarMenuSubItem ref={setNodeRef} style={style} className="relative">
          {dropIndicator}
          <div className="flex items-center group/tree-item">
            {dragHandle}
            {withDescriptionTooltip(
              <SidebarMenuSubButton
                isActive={isActive}
                className={`flex-1 ${nestHighlight}`}
                onClick={handleDocumentClick}
                onDoubleClick={handleStartRename}
              >
                {iconElement}
                {titleElement}
                {dot}
              </SidebarMenuSubButton>,
            )}
            {contextMenu}
          </div>
        </SidebarMenuSubItem>
        {deleteConfirmDialog}
      </>
    );
  }

  // Folder node (document with children, or bare folder)
  return (
    <>
      <SidebarMenuSubItem ref={setNodeRef} style={style} className="relative">
        {dropIndicator}
        <Collapsible
          open={expanded}
          onOpenChange={() => toggleExpanded(spaceId, node.path)}
          className="group/collapsible"
        >
          <div className="flex items-center group/tree-item">
            {dragHandle}
            {withDescriptionTooltip(
              <SidebarMenuSubButton
                isActive={isActive}
                className={`flex-1 ${nestHighlight}`}
                onClick={handleDocumentClick}
                onDoubleClick={handleStartRename}
              >
                <CollapsibleTrigger
                  asChild
                  onClick={(e) => e.stopPropagation()}
                >
                  <button className="relative h-4 w-4 shrink-0 flex items-center justify-center">
                    <span className="group-hover/tree-item:opacity-0 transition-opacity">
                      {iconElement}
                    </span>
                    <ChevronRight className="absolute inset-0 m-auto h-3 w-3 opacity-0 group-hover/tree-item:opacity-100 transition-all group-data-[state=open]/collapsible:rotate-90" />
                  </button>
                </CollapsibleTrigger>
                {titleElement}
                {dot}
              </SidebarMenuSubButton>,
            )}
            {contextMenu}
          </div>
          <CollapsibleContent>
            <SidebarMenuSub>
              {node.children.map((child) => (
                <FileTreeItem
                  key={child.path}
                  node={child}
                  spaceId={spaceId}
                />
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
      </SidebarMenuSubItem>
      {deleteConfirmDialog}
    </>
  );
}

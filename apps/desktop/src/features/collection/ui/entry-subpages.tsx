import { useCallback, useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { FileText, Folder, GripVertical, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "@/features/space/model";
import type { Entry } from "@/features/entry";
import { detailPageSectionClassName } from "@/shared/ui/page-layout";
import type { TreeNode } from "@/features/entry";
import { cn } from "@/shared/lib/utils";
import { normalizeEntryPath } from "../lib/utils";
import { handleError } from "../lib/errors";
import * as m from "@/paraglide/messages.js";

interface EntrySubpagesProps {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  documentPath: string;
}

export function EntrySubpages({
  spacePath,
  projectPath,
  spaceId,
  documentPath,
}: EntrySubpagesProps) {
  const openDocument = useEntrySelectionStore((state) => state.openDocument);
  const refreshTree = useSpaceStore((state) => state.refreshTree);
  const [subpages, setSubpages] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const folderPath = useMemo(
    () => folderPathForReadme(documentPath),
    [documentPath],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const load = useCallback(async () => {
    if (folderPath === null) {
      setSubpages([]);
      return;
    }
    setLoading(true);
    try {
      const tree = await invoke<TreeNode[]>("list_entries", {
        space: spacePath,
      });
      const node = findNode(tree, documentPath, folderPath);
      setSubpages(node?.children ?? []);
    } finally {
      setLoading(false);
    }
  }, [documentPath, folderPath, spacePath]);

  useEffect(() => {
    void load().catch(handleError);
  }, [load]);

  if (folderPath === null) return null;

  async function createSubpage() {
    const created = await invoke<Entry>("create_entry", {
      space: spacePath,
      parentPath: folderPath,
      title: String(m.editor_untitled()),
      contextualDefaults: null,
      projectPath: projectPath ?? null,
    });
    await refreshTree(spaceId);
    await load();
    openDocument(created.path, spaceId);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = subpages.findIndex((item) => item.path === active.id);
    const newIndex = subpages.findIndex((item) => item.path === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(subpages, oldIndex, newIndex);
    setSubpages(next);
    try {
      const existing = await invoke<Record<string, string[]>>(
        "read_tree_order",
        {
          space: spacePath,
        },
      ).catch(() => ({}));
      await invoke("save_tree_order", {
        space: spacePath,
        order: {
          ...existing,
          [folderPath || "."]: next.map(orderNameForNode),
        },
        projectPath: projectPath ?? null,
      });
      await refreshTree(spaceId);
    } catch (error) {
      setSubpages(subpages);
      throw error;
    }
  }

  return (
    <section className={detailPageSectionClassName}>
      <div className="flex items-center justify-between border-t pt-4">
        <h3 className="text-sm font-medium">{m.entry_subpages()}</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => void createSubpage().catch(handleError)}
        >
          <Plus data-icon="inline-start" />
          {m.entry_add_subpage()}
        </Button>
      </div>
      {loading ? null : subpages.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleDragEnd(event).catch(handleError)}
        >
          <SortableContext
            items={subpages.map((item) => item.path)}
            strategy={verticalListSortingStrategy}
          >
            <div className="mt-2 overflow-hidden rounded-lg border">
              {subpages.map((node) => (
                <SubpageRow
                  key={node.path}
                  node={node}
                  onOpen={() => openDocument(node.path, spaceId)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="mt-2 rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {m.entry_no_subpages()}
        </div>
      )}
    </section>
  );
}

function SubpageRow({ node, onOpen }: { node: TreeNode; onOpen: () => void }) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: node.path });
  const folder = normalizeEntryPath(node.path)
    .toLowerCase()
    .endsWith("/readme.md");
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group/subpage flex min-h-10 items-center gap-2 border-b px-2 last:border-b-0",
        isDragging && "opacity-60",
      )}
    >
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/subpage:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...attributes}
        {...listeners}
      >
        <GripVertical />
        <span className="sr-only">{m.view_query_sort_notice()}</span>
      </button>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
      >
        <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
          {node.icon ?? (folder ? <Folder /> : <FileText />)}
        </span>
        <span className="truncate">{node.title}</span>
      </button>
    </div>
  );
}

function folderPathForReadme(path: string) {
  const normalized = normalizeEntryPath(path);
  if (!normalized.toLowerCase().endsWith("/readme.md")) return null;
  return normalized.replace(/\/readme\.md$/i, "");
}

function findNode(
  nodes: TreeNode[],
  documentPath: string,
  folderPath: string,
): TreeNode | null {
  const normalizedDocumentPath = normalizeEntryPath(documentPath);
  for (const node of nodes) {
    const nodePath = normalizeEntryPath(node.path);
    const nodeFolder = nodePath.replace(/\/readme\.md$/i, "");
    if (nodePath === normalizedDocumentPath || nodeFolder === folderPath)
      return node;
    const found = findNode(node.children, documentPath, folderPath);
    if (found) return found;
  }
  return null;
}

function orderNameForNode(node: TreeNode) {
  const path = normalizeEntryPath(node.path);
  if (path.toLowerCase().endsWith("/readme.md")) {
    return (
      path
        .replace(/\/readme\.md$/i, "")
        .split("/")
        .at(-1) ?? node.name
    );
  }
  return node.name;
}

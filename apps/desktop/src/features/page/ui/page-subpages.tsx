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
import { FileText, Folder, GripVertical, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenScopeOwner } from "@/features/artifact";
import {
  createPage as createPageApi,
  savePageTreeOrderNames,
} from "../page-api";
import { useOpenPage } from "../navigation";
import { getSpaceTreeSyncSnapshot, useSpaceTreeSync } from "@/features/space";
import { detailPageSectionClassName } from "@/shared/ui/page-layout";
import type { TreeNode } from "@/features/space";
import { cn } from "@/shared/lib/utils";
import { normalizePagePath } from "../lib/path";
import { handleError } from "../lib/errors";
import { publishPageFilenameWarnings } from "../lib/filename-warning";
import * as m from "@/paraglide/messages.js";

interface PageSubpagesProps {
  spacePath: string;
  projectPath?: string | null;
  spaceId: string;
  pagePath: string;
  readOnly?: boolean;
}

export function PageSubpages({
  spacePath,
  projectPath,
  spaceId,
  pagePath,
  readOnly = false,
}: PageSubpagesProps) {
  const openPage = useOpenPage();
  const openScopeOwner = useOpenScopeOwner();
  const loadTreeChildren = useSpaceTreeSync((state) => state.loadTreeChildren);
  const [subpages, setSubpages] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const folderPath = useMemo(
    () => folderPathForReadme(pagePath),
    [pagePath],
  );
  const cachedSubpages = useSpaceTreeSync((state) =>
    folderPath ? state.childrenByParentPath[spaceId]?.[folderPath] : undefined,
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
      await loadTreeChildren(spaceId, folderPath);
      setSubpages(
        getSpaceTreeSyncSnapshot().childrenByParentPath[spaceId]?.[
          folderPath
        ] ?? [],
      );
    } finally {
      setLoading(false);
    }
  }, [folderPath, loadTreeChildren, spaceId]);

  useEffect(() => {
    void load().catch(handleError);
  }, [load]);

  useEffect(() => {
    if (cachedSubpages) setSubpages(cachedSubpages);
  }, [cachedSubpages]);

  if (folderPath === null) return null;

  async function createSubpage() {
    const created = await createPageApi({
      spacePath,
      parentPath: folderPath,
      title: String(m.editor_untitled()),
      contextualDefaults: null,
      projectPath: projectPath ?? null,
    });
    publishPageFilenameWarnings(created.warnings);
    await loadTreeChildren(spaceId, folderPath, { force: true });
    openPage(created.path, spaceId);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (readOnly || !over || active.id === over.id) return;
    const oldIndex = subpages.findIndex((item) => item.path === active.id);
    const newIndex = subpages.findIndex((item) => item.path === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(subpages, oldIndex, newIndex);
    setSubpages(next);
    try {
      await savePageTreeOrderNames({
        spacePath,
        orderKey: folderPath || ".",
        names: next.map(orderNameForNode),
        projectPath,
      });
      await loadTreeChildren(spaceId, folderPath, { force: true });
    } catch (error) {
      setSubpages(subpages);
      throw error;
    }
  }

  return (
    <section className={detailPageSectionClassName}>
      <div className="flex items-center justify-between border-t pt-4">
        <h3 className="text-sm font-medium">{m.page_subpages()}</h3>
        {!readOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => void createSubpage().catch(handleError)}
          >
            <Plus data-icon="inline-start" />
            {m.page_add_subpage()}
          </Button>
        ) : null}
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
                  readOnly={readOnly}
                  onOpen={() =>
                    node.has_schema
                      ? openScopeOwner({
                          kind: "collection",
                          path: node.path,
                          spaceId,
                        })
                      : openPage(node.path, spaceId)
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="mt-2 rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {m.page_no_subpages()}
        </div>
      )}
    </section>
  );
}

function SubpageRow({
  node,
  onOpen,
  readOnly,
}: {
  node: TreeNode;
  onOpen: () => void;
  readOnly: boolean;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: node.path, disabled: readOnly });
  const folder = normalizePagePath(node.path)
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
      {!readOnly ? (
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/subpage:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...attributes}
          {...listeners}
        >
          <GripVertical />
          <span className="sr-only">{m.view_query_sort_notice()}</span>
        </button>
      ) : null}
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
  const normalized = normalizePagePath(path);
  if (!normalized.toLowerCase().endsWith("/readme.md")) return null;
  return normalized.replace(/\/readme\.md$/i, "");
}

function orderNameForNode(node: TreeNode) {
  const path = normalizePagePath(node.path);
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

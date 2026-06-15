import { useSidebar } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEntrySelectionStore } from "@/features/entry";
import { useSpaceStore } from "../model";
import type { TreeNode } from "@/features/entry";

function findTitleInTree(
  nodes: TreeNode[],
  targetPath: string,
): string | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node.title;
    const folderPath = node.path.replace(/\/readme\.md$/i, "");
    if (folderPath === targetPath) return node.title;
    if (node.children.length > 0) {
      const found = findTitleInTree(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function buildSegments(
  docPath: string,
  tree: TreeNode[],
): { label: string; path: string }[] {
  const parts = docPath.split("/");
  const segments: { label: string; path: string }[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const cumPath = parts.slice(0, i + 1).join("/");

    if (i === parts.length - 1 && part.toLowerCase() === "readme.md") continue;

    if (i < parts.length - 1) {
      const title = findTitleInTree(tree, cumPath) ?? part;
      segments.push({ label: title, path: cumPath + "/readme.md" });
    } else {
      const title =
        findTitleInTree(tree, cumPath) ?? part.replace(/\.md$/, "");
      segments.push({ label: title, path: cumPath });
    }
  }

  return segments;
}

export function MainBreadcrumbs() {
  const { activeDocument, activeDocumentSpaceId, openDocument } =
    useEntrySelectionStore();
  const { rootSpaces, spaces, fileTrees, openSpace } = useSpaceStore();

  if (!activeDocument) return null;

  const allSpaces = [...rootSpaces, ...spaces];
  const activeWorkspace = activeDocumentSpaceId
    ? allSpaces.find((w) => w.id === activeDocumentSpaceId)
    : null;
  const workspaceName = activeWorkspace
    ? `${activeWorkspace.icon} ${activeWorkspace.name}`
    : "";

  const treeId = activeDocumentSpaceId;
  const tree = treeId ? fileTrees[treeId] ?? [] : [];
  const segments = buildSegments(activeDocument, tree);

  const MAX_VISIBLE = 3;
  const needsEllipsis = segments.length > MAX_VISIBLE;
  const visibleSegments = needsEllipsis
    ? [segments[0], ...segments.slice(-2)]
    : segments;

  return (
    <div className="min-w-0 flex-1 px-2">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm">
          {workspaceName && (
            <>
              <BreadcrumbItem className="min-w-0">
                <WorkspaceBreadcrumb
                  label={workspaceName}
                  workspaces={allSpaces}
                  onSwitch={openSpace}
                />
              </BreadcrumbItem>
              {segments.length > 0 && (
                <BreadcrumbSeparator className="shrink-0" />
              )}
            </>
          )}
          {visibleSegments.map((seg, i) => (
            <span key={seg.path} className="contents">
              {i === 1 && needsEllipsis && (
                <>
                  <BreadcrumbItem className="shrink-0">
                    <BreadcrumbEllipsis />
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="shrink-0" />
                </>
              )}
              <BreadcrumbItem className="min-w-0">
                <button
                  className="block max-w-[220px] truncate text-left transition-colors hover:text-foreground"
                  onClick={() => openDocument(seg.path, treeId ?? undefined)}
                >
                  {seg.label}
                </button>
              </BreadcrumbItem>
              {i < visibleSegments.length - 1 && (
                <BreadcrumbSeparator className="shrink-0" />
              )}
            </span>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}

function WorkspaceBreadcrumb({
  label,
  workspaces,
  onSwitch,
}: {
  label: string;
  workspaces: { id: string; name: string; icon: string }[];
  onSwitch: (id: string) => void;
}) {
  const { state } = useSidebar();
  const isSidebarCollapsed = state === "collapsed";

  if (!isSidebarCollapsed || workspaces.length <= 1) {
    return <span className="block max-w-[220px] truncate">{label}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="block max-w-[220px] truncate text-left transition-colors hover:text-foreground">
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {workspaces.map((ws) => (
          <DropdownMenuItem key={ws.id} onClick={() => onSwitch(ws.id)}>
            <span className="mr-2">{ws.icon}</span>
            {ws.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

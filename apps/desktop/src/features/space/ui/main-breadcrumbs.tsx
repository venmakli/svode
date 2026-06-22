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
import { useMainBreadcrumbs } from "../hooks/use-main-breadcrumbs";

export function MainBreadcrumbs() {
  const {
    activeDocument,
    openDocument,
    openSpace,
    selectedSpace,
    segments,
    treeId,
    workspaceName,
    workspaces,
  } = useMainBreadcrumbs();

  if (!activeDocument) {
    if (!selectedSpace) return null;
    return (
      <div className="min-w-0 flex-1 px-2">
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-sm">
            <BreadcrumbItem className="min-w-0">
              <span className="block max-w-[220px] truncate">
                {selectedSpace.icon} {selectedSpace.name}
              </span>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    );
  }

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
                  workspaces={workspaces}
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

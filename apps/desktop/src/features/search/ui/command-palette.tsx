import { useMemo, useState } from "react";
import { CommandInput, CommandList } from "@/components/ui/command";
import {
  createDefaultKnowledgeFilters,
  getDirectNeighborDetails,
  getMatchedNodeIds,
  getNodeById,
  KnowledgeGraphView,
  KnowledgeGraphResetButton,
  KnowledgeCommandResults,
  KnowledgeOpenGraphButton,
  knowledgeOpenPath,
  KnowledgeNodeDetail,
  KnowledgeScopeControls,
  KnowledgeStatus,
  useKnowledgeNeighbors,
  useKnowledgeSnapshot,
  withSearchResultNodes,
  type KnowledgeGraphState,
  type KnowledgeNode,
  type KnowledgeSearchItem,
  type KnowledgeSpaceOption,
} from "@/features/knowledge";
import { useSpace, type SpaceInfo } from "@/features/space";
import { useCommandPaletteStore } from "../model";
import {
  useSelectResult,
  type SearchNavigationTarget,
} from "../hooks/use-select-result";
import { SearchBreadcrumb } from "./search-breadcrumb";
import { SearchDialog } from "./search-dialog";
import { SearchDialogShell } from "./search-dialog-shell";
import * as m from "@/paraglide/messages.js";

/** The project Search looks in: its root names the scope of the whole project. */
export interface SearchProject {
  path: string;
  name: string;
  /** The child Spaces of the project; the ready ones are the Space scopes. */
  spaces: readonly Pick<SpaceInfo, "id" | "name" | "status">[];
}

interface CommandPaletteProps {
  /** Nothing opens without a project. */
  project: SearchProject | null;
  /** Opens a result where the host shows objects. */
  onSelect: (target: SearchNavigationTarget) => void | Promise<void>;
  onBeforeNavigation?: () => Promise<boolean>;
  /** "Open graph" is offered only where the full-screen Graph is. */
  onOpenGraph?: (state: KnowledgeGraphState) => void;
}

/**
 * Search of the window's project in its Space: a result opens in its Space
 * and is revealed in the tree.
 */
export function SpaceCommandPalette({
  onBeforeNavigation,
  onAfterNavigation,
  onOpenGraph,
}: {
  onBeforeNavigation?: () => Promise<boolean>;
  onAfterNavigation?: () => void;
  onOpenGraph: (state: KnowledgeGraphState) => void;
}) {
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const activeRootName = useSpace((s) => s.activeRootName);
  const spaces = useSpace((s) => s.spaces);
  const handleSelect = useSelectResult({
    onBeforeNavigation,
    onAfterNavigation,
  });

  return (
    <CommandPalette
      project={
        activeRootPath
          ? { path: activeRootPath, name: activeRootName ?? "Svode", spaces }
          : null
      }
      onSelect={handleSelect}
      onBeforeNavigation={onBeforeNavigation}
      onOpenGraph={onOpenGraph}
    />
  );
}

/** The Search dialog of one project, opened and closed by its store. */
export function CommandPalette({
  project,
  onSelect,
  onBeforeNavigation,
  onOpenGraph,
}: CommandPaletteProps) {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  if (!open || !project) return null;

  return (
    <CommandPaletteDialog
      key={project.path}
      projectPath={project.path}
      open={open}
      setOpen={setOpen}
      onSelect={onSelect}
      onBeforeNavigation={onBeforeNavigation}
      onOpenGraph={onOpenGraph}
      spaces={[
        { id: null, name: project.name },
        ...project.spaces
          .filter((space) => space.status === "ready")
          .map((space) => ({ id: space.id, name: space.name })),
      ]}
    />
  );
}

function CommandPaletteDialog({
  projectPath,
  open,
  setOpen,
  onSelect,
  onBeforeNavigation,
  onOpenGraph,
  spaces,
}: Omit<CommandPaletteProps, "project"> & {
  projectPath: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  spaces: KnowledgeSpaceOption[];
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<KnowledgeGraphState["scope"]>({
    kind: "project",
  });
  const [filters, setFilters] = useState(createDefaultKnowledgeFilters);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const knowledge = useKnowledgeSnapshot(projectPath, scope, query, filters);
  const visibleSnapshot = useMemo(
    () => withSearchResultNodes(knowledge.snapshot),
    [knowledge.snapshot],
  );
  const visibleKnowledge = { ...knowledge, snapshot: visibleSnapshot };
  const selectedNode = getNodeById(visibleSnapshot, selectedNodeId);
  const breadcrumbNode =
    selectedNode ?? getNodeById(visibleSnapshot, focusedNodeId);
  const neighborState = useKnowledgeNeighbors(
    projectPath,
    scope,
    filters,
    selectedNode,
  );
  const neighbors = getDirectNeighborDetails(
    visibleSnapshot,
    selectedNodeId,
    neighborState.edges,
  );
  const matchedNodeIds = useMemo(
    () => getMatchedNodeIds(visibleSnapshot, query),
    [query, visibleSnapshot],
  );
  const openKnowledgeSource = (node: KnowledgeNode | KnowledgeSearchItem) =>
    onSelect({
      spaceId: node.source.spaceId,
      spaceName: node.spaceName,
      path: knowledgeOpenPath(node),
      kind: node.source.kind,
      title: node.title,
    });
  const openGraph = async (open: (state: KnowledgeGraphState) => void) => {
    if (onBeforeNavigation && !(await onBeforeNavigation())) return;
    setOpen(false);
    open({
      query,
      scope,
      filters,
      selectedNodeId: selectedNodeId ?? focusedNodeId,
    });
  };

  return (
    <SearchDialog
      open={open}
      onOpenChange={setOpen}
      title={m.search_dialog_title()}
      description={m.search_dialog_description()}
    >
      <SearchDialogShell
        sidebarLabel={m.search_results_sidebar()}
        commandValue={focusedNodeId ?? ""}
        onCommandValueChange={(value) => setFocusedNodeId(value || null)}
        searchInput={
          <CommandInput
            autoFocus
            placeholder={m.search_placeholder()}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setSelectedNodeId(null);
              setFocusedNodeId(null);
            }}
          />
        }
        scopeControls={
          <KnowledgeScopeControls
            scope={scope}
            filters={filters}
            spaces={spaces}
            onScopeChange={(nextScope) => {
              setScope(nextScope);
              setSelectedNodeId(null);
              setFocusedNodeId(null);
            }}
            onFiltersChange={(nextFilters) => {
              setFilters(nextFilters);
              setSelectedNodeId(null);
              setFocusedNodeId(null);
            }}
          />
        }
        readingContent={
          selectedNode ? (
            <KnowledgeNodeDetail
              node={selectedNode}
              neighbors={neighbors}
              neighborsLoading={neighborState.loading}
              neighborsError={neighborState.error}
              onBack={() => setSelectedNodeId(null)}
              onSelectNode={setSelectedNodeId}
              onOpenSource={openKnowledgeSource}
            />
          ) : (
            <CommandList className="max-h-none min-h-0 flex-1">
              <KnowledgeCommandResults
                items={knowledge.snapshot?.searchItems ?? []}
                loading={knowledge.loading}
                emptyMessage={
                  query.trim() === ""
                    ? m.search_empty_prompt()
                    : m.search_no_results()
                }
                heading={
                  query.trim() === "" ? m.search_group_recent() : undefined
                }
                onActiveChange={setFocusedNodeId}
                onOpen={openKnowledgeSource}
              />
            </CommandList>
          )
        }
        status={<KnowledgeStatus state={visibleKnowledge} placement="inline" />}
        breadcrumb={
          <SearchBreadcrumb
            node={breadcrumbNode}
            scope={scope}
            spaces={spaces}
          />
        }
        openGraphAction={
          onOpenGraph && (
            <KnowledgeOpenGraphButton
              onOpen={() => void openGraph(onOpenGraph)}
            />
          )
        }
        graph={
          <KnowledgeGraphView
            state={visibleKnowledge}
            selectedNodeId={selectedNodeId}
            focusedNodeId={focusedNodeId}
            matchedNodeIds={matchedNodeIds}
            resetKey={resetKey}
            onNodeSelect={setSelectedNodeId}
            showStatus={false}
          />
        }
        resetAction={
          <KnowledgeGraphResetButton
            variant="outline"
            onReset={() => setResetKey((value) => value + 1)}
          />
        }
      />
    </SearchDialog>
  );
}

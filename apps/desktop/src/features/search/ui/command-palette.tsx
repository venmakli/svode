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
import { useSpace } from "@/features/space";
import { useCommandPaletteStore } from "../model";
import { useSelectResult } from "../hooks/use-select-result";
import { SearchBreadcrumb } from "./search-breadcrumb";
import { SearchDialog } from "./search-dialog";
import { SearchDialogShell } from "./search-dialog-shell";
import * as m from "@/paraglide/messages.js";

export function CommandPalette({
  onBeforeNavigation,
  onAfterNavigation,
  onOpenGraph,
}: {
  onBeforeNavigation?: () => Promise<boolean>;
  onAfterNavigation?: () => void;
  onOpenGraph: (state: KnowledgeGraphState) => void;
}) {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const activeRootPath = useSpace((s) => s.activeRootPath);
  const activeRootName = useSpace((s) => s.activeRootName);
  const spaces = useSpace((s) => s.spaces);

  if (!open) return null;

  return (
    <CommandPaletteDialog
      activeRootPath={activeRootPath}
      open={open}
      setOpen={setOpen}
      onBeforeNavigation={onBeforeNavigation}
      onAfterNavigation={onAfterNavigation}
      onOpenGraph={onOpenGraph}
      spaces={[
        { id: null, name: activeRootName ?? "Svode" },
        ...spaces
          .filter((space) => space.status === "ready")
          .map((space) => ({ id: space.id, name: space.name })),
      ]}
    />
  );
}

function CommandPaletteDialog({
  activeRootPath,
  open,
  setOpen,
  onBeforeNavigation,
  onAfterNavigation,
  onOpenGraph,
  spaces,
}: {
  activeRootPath: string | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  onBeforeNavigation?: () => Promise<boolean>;
  onAfterNavigation?: () => void;
  onOpenGraph: (state: KnowledgeGraphState) => void;
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
  const knowledge = useKnowledgeSnapshot(activeRootPath, scope, query, filters);
  const visibleSnapshot = useMemo(
    () => withSearchResultNodes(knowledge.snapshot),
    [knowledge.snapshot],
  );
  const visibleKnowledge = { ...knowledge, snapshot: visibleSnapshot };
  const handleSelect = useSelectResult({
    onBeforeNavigation,
    onAfterNavigation,
  });
  const selectedNode = getNodeById(visibleSnapshot, selectedNodeId);
  const breadcrumbNode =
    selectedNode ?? getNodeById(visibleSnapshot, focusedNodeId);
  const neighborState = useKnowledgeNeighbors(
    activeRootPath,
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
    handleSelect({
      spaceId: node.source.spaceId,
      spaceName: node.spaceName,
      path: knowledgeOpenPath(node),
      kind: node.source.kind,
    });
  const openGraph = async () => {
    if (onBeforeNavigation && !(await onBeforeNavigation())) return;
    setOpen(false);
    onOpenGraph({
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
          <KnowledgeOpenGraphButton onOpen={() => void openGraph()} />
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

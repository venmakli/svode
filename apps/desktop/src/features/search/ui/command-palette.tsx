import { useMemo, useState } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  createDefaultKnowledgeFilters,
  getDirectNeighborDetails,
  getMatchedNodeIds,
  getNodeById,
  KnowledgeGraphView,
  KnowledgeCommandResults,
  knowledgeOpenPath,
  KnowledgeNodeDetail,
  KnowledgeToolbar,
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={m.search_dialog_title()}
      description={m.search_dialog_description()}
      shouldFilter={false}
      commandValue={focusedNodeId ?? ""}
      onCommandValueChange={(value) => setFocusedNodeId(value || null)}
      loop
      className="top-1/2 size-[min(82vh,calc(100vw-2rem),860px)] max-w-none -translate-y-1/2 sm:max-w-none"
    >
      <div className="flex items-center gap-2 border-b pr-2">
        <div className="min-w-0 flex-1">
          <CommandInput
            placeholder={m.search_placeholder()}
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setSelectedNodeId(null);
              setFocusedNodeId(null);
            }}
          />
        </div>
        <KnowledgeToolbar
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
          onReset={() => setResetKey((value) => value + 1)}
          onExpand={async () => {
            if (onBeforeNavigation && !(await onBeforeNavigation())) return;
            setOpen(false);
            onOpenGraph({ query, scope, filters, selectedNodeId });
          }}
        />
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="62%" minSize="40%">
          <KnowledgeGraphView
            state={visibleKnowledge}
            selectedNodeId={selectedNodeId}
            focusedNodeId={focusedNodeId}
            matchedNodeIds={matchedNodeIds}
            resetKey={resetKey}
            onNodeSelect={setSelectedNodeId}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="38%" minSize="280px" maxSize="55%">
          {selectedNode ? (
            <KnowledgeNodeDetail
              node={selectedNode}
              neighbors={neighbors}
              neighborsLoading={neighborState.loading}
              neighborsError={neighborState.error}
              onSelectNode={setSelectedNodeId}
              onOpenSource={openKnowledgeSource}
            />
          ) : (
            <div className="flex size-full min-h-0 flex-col">
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
                  onOpen={openKnowledgeSource}
                />
              </CommandList>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </CommandDialog>
  );
}

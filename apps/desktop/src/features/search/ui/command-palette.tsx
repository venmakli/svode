import { useMemo, useState } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
} from "@/components/ui/command";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  getDirectNeighbors,
  getMatchedNodeIds,
  getNodeById,
  KnowledgeGraphView,
  KnowledgeNodeDetail,
  KnowledgeToolbar,
  useKnowledgeSnapshot,
  type KnowledgeGraphState,
  type KnowledgeNode,
  type KnowledgeSpaceOption,
} from "@/features/knowledge";
import { useSpace } from "@/features/space";
import { useCommandPaletteStore } from "../model";
import { useSearch } from "../hooks/use-search";
import { useSelectResult } from "../hooks/use-select-result";
import { ResultItem } from "./result-item";
import { dedupKey } from "../lib/utils";
import type { SearchItem } from "../model";
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const search = useSearch(query, activeRootPath, scope);
  const knowledge = useKnowledgeSnapshot(activeRootPath, scope, query);
  const handleSelect = useSelectResult({
    onBeforeNavigation,
    onAfterNavigation,
  });
  const selectedNode = getNodeById(knowledge.snapshot, selectedNodeId);
  const neighbors = getDirectNeighbors(knowledge.snapshot, selectedNodeId);
  const matchedNodeIds = useMemo(
    () => getMatchedNodeIds(knowledge.snapshot, query),
    [knowledge.snapshot, query],
  );
  const openKnowledgeNode = (node: KnowledgeNode) =>
    handleSelect({
      spaceId: node.source.spaceId,
      spaceName: node.spaceName,
      path: node.source.path,
    });

  const showProgress =
    search.totalSpaces > 1 &&
    search.indexedSpaces < search.totalSpaces &&
    !search.isEmpty;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={m.search_dialog_title()}
      description={m.search_dialog_description()}
      shouldFilter={false}
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
            }}
          />
        </div>
        <KnowledgeToolbar
          scope={scope}
          spaces={spaces}
          onScopeChange={(nextScope) => {
            setScope(nextScope);
            setSelectedNodeId(null);
          }}
          onReset={() => setResetKey((value) => value + 1)}
          onExpand={async () => {
            if (onBeforeNavigation && !(await onBeforeNavigation())) return;
            setOpen(false);
            onOpenGraph({ query, scope, selectedNodeId });
          }}
        />
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="62%" minSize="40%">
          <KnowledgeGraphView
            state={knowledge}
            selectedNodeId={selectedNodeId}
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
              onSelectNode={setSelectedNodeId}
              onOpenSource={openKnowledgeNode}
            />
          ) : (
            <div className="flex size-full min-h-0 flex-col">
              <CommandList className="max-h-none min-h-0 flex-1">
                <SearchResults search={search} onSelect={handleSelect} />
              </CommandList>
              {showProgress && (
                <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                  {m.search_indexing_progress({
                    done: search.indexedSpaces,
                    total: search.totalSpaces,
                  })}
                </div>
              )}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </CommandDialog>
  );
}

function SearchResults({
  search,
  onSelect,
}: {
  search: ReturnType<typeof useSearch>;
  onSelect: (item: SearchItem) => void | Promise<void>;
}) {
  if (search.isEmpty) {
    if (search.recent.length === 0) {
      return <CommandEmpty>{m.search_empty_prompt()}</CommandEmpty>;
    }
    return (
      <CommandGroup heading={m.search_group_recent()}>
        {search.recent.map((item) => (
          <ResultItem key={dedupKey(item)} item={item} onSelect={onSelect} />
        ))}
      </CommandGroup>
    );
  }

  if (search.titles.length === 0 && search.contents.length === 0) {
    if (search.isLoading) return null;
    return <CommandEmpty>{m.search_no_results()}</CommandEmpty>;
  }

  return (
    <>
      {search.titles.length > 0 && (
        <CommandGroup heading={m.search_group_titles()}>
          {search.titles.map((item) => (
            <ResultItem key={dedupKey(item)} item={item} onSelect={onSelect} />
          ))}
        </CommandGroup>
      )}
      {search.contents.length > 0 && (
        <>
          {search.titles.length > 0 && <CommandSeparator />}
          <CommandGroup heading={m.search_group_contents()}>
            {search.contents.map((item) => (
              <ResultItem
                key={dedupKey(item)}
                item={item}
                onSelect={onSelect}
              />
            ))}
          </CommandGroup>
        </>
      )}
    </>
  );
}

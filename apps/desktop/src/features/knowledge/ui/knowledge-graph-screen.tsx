import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useKnowledgeSnapshot } from "../hooks/use-knowledge-snapshot";
import { useKnowledgeNeighbors } from "../hooks/use-knowledge-neighbors";
import {
  getDirectNeighborDetails,
  getMatchedNodeIds,
  getNodeById,
  withSearchResultNodes,
} from "../model/projection";
import { createDefaultKnowledgeFilters } from "../model/filters";
import type {
  KnowledgeGraphState,
  KnowledgeNode,
  KnowledgeSpaceOption,
} from "../model/types";
import { KnowledgeGraphView } from "./knowledge-graph-view";
import { KnowledgeNodeDetail } from "./knowledge-node-detail";
import { KnowledgeResultList } from "./knowledge-search-results";
import { KnowledgeToolbar } from "./knowledge-toolbar";
import * as m from "@/paraglide/messages.js";

export interface KnowledgeGraphOpenRequest extends KnowledgeGraphState {
  requestKey: number;
}

export function KnowledgeGraphScreen({
  projectPath,
  spaces,
  openRequest,
  onOpenSource,
}: {
  projectPath: string;
  spaces: KnowledgeSpaceOption[];
  openRequest: KnowledgeGraphOpenRequest | null;
  onOpenSource: (node: KnowledgeNode) => void | Promise<void>;
}) {
  const [graphState, setGraphState] = useState<KnowledgeGraphState>(() =>
    stateFromRequest(openRequest),
  );
  const [resetKey, setResetKey] = useState(0);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const knowledge = useKnowledgeSnapshot(
    projectPath,
    graphState.scope,
    graphState.query,
    graphState.filters,
    "complete",
  );
  const visibleSnapshot = useMemo(
    () => withSearchResultNodes(knowledge.snapshot),
    [knowledge.snapshot],
  );
  const visibleKnowledge = { ...knowledge, snapshot: visibleSnapshot };
  const selectedNode = getNodeById(visibleSnapshot, graphState.selectedNodeId);
  const neighborState = useKnowledgeNeighbors(
    projectPath,
    graphState.scope,
    graphState.filters,
    selectedNode,
  );
  const neighbors = getDirectNeighborDetails(
    visibleSnapshot,
    graphState.selectedNodeId,
    neighborState.edges,
  );
  const matchedNodeIds = useMemo(
    () => getMatchedNodeIds(visibleSnapshot, graphState.query),
    [graphState.query, visibleSnapshot],
  );

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <h1 className="shrink-0 text-base font-medium">
          {m.knowledge_graph_title()}
        </h1>
        <InputGroup className="min-w-48 flex-1">
          <InputGroupInput
            value={graphState.query}
            placeholder={m.search_placeholder()}
            onChange={(event) => {
              setFocusedNodeId(null);
              setGraphState((previous) => ({
                ...previous,
                query: event.target.value,
                selectedNodeId: null,
              }));
            }}
          />
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
        </InputGroup>
        <KnowledgeToolbar
          scope={graphState.scope}
          filters={graphState.filters}
          spaces={spaces}
          onScopeChange={(scope) => {
            setFocusedNodeId(null);
            setGraphState((previous) => ({
              ...previous,
              scope,
              selectedNodeId: null,
            }));
          }}
          onFiltersChange={(filters) => {
            setFocusedNodeId(null);
            setGraphState((previous) => ({
              ...previous,
              filters,
              selectedNodeId: null,
            }));
          }}
          onReset={() => setResetKey((value) => value + 1)}
        />
      </header>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="65%" minSize="40%">
          <KnowledgeGraphView
            state={visibleKnowledge}
            selectedNodeId={graphState.selectedNodeId}
            focusedNodeId={focusedNodeId}
            matchedNodeIds={matchedNodeIds}
            resetKey={resetKey}
            onNodeSelect={(selectedNodeId) =>
              setGraphState((previous) => ({ ...previous, selectedNodeId }))
            }
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="35%" minSize="280px" maxSize="50%">
          {selectedNode ? (
            <KnowledgeNodeDetail
              node={selectedNode}
              neighbors={neighbors}
              neighborsLoading={neighborState.loading}
              neighborsError={neighborState.error}
              onSelectNode={(selectedNodeId) =>
                setGraphState((previous) => ({ ...previous, selectedNodeId }))
              }
              onOpenSource={onOpenSource}
            />
          ) : (
            <KnowledgeResultList
              items={visibleSnapshot?.searchItems ?? []}
              loading={knowledge.loading}
              onFocus={setFocusedNodeId}
              onSelect={(selectedNodeId) =>
                setGraphState((previous) => ({ ...previous, selectedNodeId }))
              }
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function stateFromRequest(
  request: KnowledgeGraphOpenRequest | null,
): KnowledgeGraphState {
  return request
    ? {
        query: request.query,
        scope: request.scope,
        filters: request.filters,
        selectedNodeId: request.selectedNodeId,
      }
    : {
        query: "",
        scope: { kind: "project" },
        filters: createDefaultKnowledgeFilters(),
        selectedNodeId: null,
      };
}

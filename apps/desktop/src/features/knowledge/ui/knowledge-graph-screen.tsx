import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useKnowledgeSnapshot } from "../hooks/use-knowledge-snapshot";
import {
  getDirectNeighbors,
  getMatchedNodeIds,
  getNodeById,
} from "../model/projection";
import type {
  KnowledgeGraphState,
  KnowledgeNode,
  KnowledgeSpaceOption,
} from "../model/types";
import { KnowledgeGraphView } from "./knowledge-graph-view";
import { KnowledgeNodeDetail } from "./knowledge-node-detail";
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

  const knowledge = useKnowledgeSnapshot(
    projectPath,
    graphState.scope,
    graphState.query,
    "complete",
  );
  const selectedNode = getNodeById(
    knowledge.snapshot,
    graphState.selectedNodeId,
  );
  const neighbors = getDirectNeighbors(
    knowledge.snapshot,
    graphState.selectedNodeId,
  );
  const matchedNodeIds = useMemo(
    () => getMatchedNodeIds(knowledge.snapshot, graphState.query),
    [graphState.query, knowledge.snapshot],
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
            onChange={(event) =>
              setGraphState((previous) => ({
                ...previous,
                query: event.target.value,
                selectedNodeId: null,
              }))
            }
          />
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
        </InputGroup>
        <KnowledgeToolbar
          scope={graphState.scope}
          spaces={spaces}
          onScopeChange={(scope) =>
            setGraphState((previous) => ({
              ...previous,
              scope,
              selectedNodeId: null,
            }))
          }
          onReset={() => setResetKey((value) => value + 1)}
        />
      </header>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="65%" minSize="40%">
          <KnowledgeGraphView
            state={knowledge}
            selectedNodeId={graphState.selectedNodeId}
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
              onSelectNode={(selectedNodeId) =>
                setGraphState((previous) => ({ ...previous, selectedNodeId }))
              }
              onOpenSource={onOpenSource}
            />
          ) : (
            <KnowledgeResults
              nodes={knowledge.snapshot?.searchItems ?? []}
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

function KnowledgeResults({
  nodes,
  onSelect,
}: {
  nodes: Array<{
    nodeId: string;
    title: string;
    spaceName: string;
    source: { path: string };
  }>;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <ScrollArea className="size-full">
      <div className="flex flex-col gap-1 p-2">
        <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
          {m.knowledge_graph_results()}
        </p>
        {nodes.map((node) => (
          <Button
            key={node.nodeId}
            type="button"
            variant="ghost"
            className="h-auto justify-start px-2 py-2"
            onClick={() => onSelect(node.nodeId)}
          >
            <FileText data-icon="inline-start" />
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate">{node.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {node.spaceName} · {node.source.path}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </ScrollArea>
  );
}

function stateFromRequest(
  request: KnowledgeGraphOpenRequest | null,
): KnowledgeGraphState {
  return request
    ? {
        query: request.query,
        scope: request.scope,
        selectedNodeId: request.selectedNodeId,
      }
    : { query: "", scope: { kind: "project" }, selectedNodeId: null };
}

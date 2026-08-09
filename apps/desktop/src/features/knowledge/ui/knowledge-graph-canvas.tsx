import { useCallback, useEffect, useRef } from "react";
import ForceGraph from "force-graph";
import {
  buildGraphRenderData,
  endpointId,
  resetGraphRenderPositions,
  type GraphRenderLink,
  type GraphRenderNode,
} from "../lib/graph-model";
import type { KnowledgeEdge, KnowledgeNode } from "../model/types";

type GraphRenderer = ForceGraph<GraphRenderNode, GraphRenderLink>;

const NODE_DIMMED_COLOR = "#e7e5e4";
const NODE_LABEL_COLOR = "#57534e";
const EDGE_COLOR = "rgba(148, 163, 184, 0.46)";
const EDGE_FOCUS_COLOR = "rgba(100, 116, 139, 0.9)";
const EDGE_DIMMED_COLOR = "rgba(231, 229, 228, 0.18)";

let activeRenderer: GraphRenderer | null = null;

export function KnowledgeGraphCanvas({
  nodes,
  edges,
  totalNodeCount,
  selectedNodeId,
  focusedNodeId,
  matchedNodeIds,
  resetKey,
  loadingMore,
  onNodeSelect,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  totalNodeCount: number;
  selectedNodeId: string | null;
  focusedNodeId: string | null;
  matchedNodeIds: Set<string>;
  resetKey: number;
  loadingMore: boolean;
  onNodeSelect: (nodeId: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  const dataRef = useRef<{
    nodes: GraphRenderNode[];
    links: GraphRenderLink[];
  }>({
    nodes: [],
    links: [],
  });
  const neighborsRef = useRef(new Map<string, Set<string>>());
  const graphNodeIdsRef = useRef(new Set<string>());
  const hoveredNodeIdRef = useRef<string | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const focusedNodeIdRef = useRef(focusedNodeId);
  const matchedNodeIdsRef = useRef(matchedNodeIds);
  const activeNodeIdsRef = useRef<Set<string> | null>(null);
  const onNodeSelectRef = useRef(onNodeSelect);
  const fitTimeoutRef = useRef<number | null>(null);
  const wasLoadingMoreRef = useRef(loadingMore);

  const refreshActiveSubgraph = useCallback(() => {
    const seedCandidate =
      hoveredNodeIdRef.current ??
      focusedNodeIdRef.current ??
      selectedNodeIdRef.current;
    const seed =
      seedCandidate && graphNodeIdsRef.current.has(seedCandidate)
        ? seedCandidate
        : null;
    if (seed) {
      activeNodeIdsRef.current = new Set([
        seed,
        ...(neighborsRef.current.get(seed) ?? []),
      ]);
    } else {
      const visibleMatches = new Set(
        [...matchedNodeIdsRef.current].filter((nodeId) =>
          graphNodeIdsRef.current.has(nodeId),
        ),
      );
      activeNodeIdsRef.current =
        visibleMatches.size > 0 ? visibleMatches : null;
    }
    activeNodeIdsRefForAccessor.current = activeNodeIdsRef.current;

    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer
      .nodeColor(getNodeColor)
      .linkColor(getLinkColor)
      .nodeCanvasObjectMode(getNodeCanvasMode);
  }, []);

  useEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
  }, [onNodeSelect]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
    focusedNodeIdRef.current = focusedNodeId;
    matchedNodeIdsRef.current = matchedNodeIds;
    refreshActiveSubgraph();

    const renderer = rendererRef.current;
    const centeredNodeId = focusedNodeId ?? selectedNodeId;
    const selectedNode = centeredNodeId
      ? dataRef.current.nodes.find((node) => node.id === centeredNodeId)
      : null;
    if (
      renderer &&
      selectedNode?.x !== undefined &&
      selectedNode.y !== undefined
    ) {
      renderer.centerAt(selectedNode.x, selectedNode.y, 350);
      renderer.zoom(Math.max(renderer.zoom(), 1.6), 350);
    }
  }, [focusedNodeId, matchedNodeIds, refreshActiveSubgraph, selectedNodeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    activeRenderer?._destructor();
    const renderer = new ForceGraph<GraphRenderNode, GraphRenderLink>(container)
      .backgroundColor("rgba(255, 255, 255, 0)")
      .nodeId("id")
      .nodeRelSize(1.85)
      .nodeVal((node) => node.value)
      .nodeLabel((node) => node.label)
      .nodeColor(getNodeColor)
      .nodeCanvasObjectMode(getNodeCanvasMode)
      .nodeCanvasObject(drawNodeLabel)
      .linkColor(getLinkColor)
      .linkWidth(0.65)
      .enableNodeDrag(true)
      .enablePanInteraction(true)
      .enableZoomInteraction(true)
      .autoPauseRedraw(true)
      .d3AlphaDecay(0.028)
      .d3VelocityDecay(0.42)
      .cooldownTime(12_000)
      .cooldownTicks(420)
      .showPointerCursor((item) => item !== undefined)
      .onNodeClick((node) => onNodeSelectRef.current(node.id))
      .onBackgroundClick(() => onNodeSelectRef.current(null))
      .onNodeHover((node) => {
        hoveredNodeIdRef.current = node?.id ?? null;
        container.style.cursor = node ? "grab" : "default";
        refreshActiveSubgraph();
      })
      .onNodeDrag(() => {
        container.style.cursor = "grabbing";
      })
      .onNodeDragEnd((node) => {
        container.style.cursor = "grab";
        if (node.connected) {
          node.fx = undefined;
          node.fy = undefined;
          renderer.d3ReheatSimulation();
        } else {
          node.fx = node.x;
          node.fy = node.y;
        }
      });

    const chargeForce = renderer.d3Force("charge");
    chargeForce?.strength?.((node: GraphRenderNode) =>
      node.connected ? -20 - Math.min(node.degree * 0.35, 12) : 0,
    );
    chargeForce?.theta?.(1.12);
    chargeForce?.distanceMin?.(2);
    chargeForce?.distanceMax?.(420);
    const linkForce = renderer.d3Force("link");
    linkForce?.distance?.(44);
    linkForce?.strength?.(0.2);

    rendererRef.current = renderer;
    activeRenderer = renderer;
    const resizeObserver = new ResizeObserver(() => {
      renderer.width(container.clientWidth).height(container.clientHeight);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (fitTimeoutRef.current !== null) {
        window.clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      renderer._destructor();
      if (activeRenderer === renderer) {
        activeRenderer = null;
        activeNodeIdsRefForAccessor.current = null;
      }
      rendererRef.current = null;
    };
  }, [refreshActiveSubgraph]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const nextData = buildGraphRenderData({
      nodes,
      edges,
      totalNodeCount,
      previousNodes: dataRef.current.nodes,
    });
    const firstProjection = dataRef.current.nodes.length === 0;
    neighborsRef.current = nextData.neighbors;
    graphNodeIdsRef.current = new Set(nextData.nodes.map((node) => node.id));
    dataRef.current = { nodes: nextData.nodes, links: nextData.links };
    renderer.graphData(dataRef.current).d3ReheatSimulation();
    refreshActiveSubgraph();

    if (firstProjection) {
      scheduleFit(renderer, fitTimeoutRef, 420);
    }
  }, [edges, nodes, refreshActiveSubgraph, totalNodeCount]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (wasLoadingMoreRef.current && !loadingMore) {
      scheduleFit(renderer, fitTimeoutRef, 520);
    }
    wasLoadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  useEffect(() => {
    if (resetKey === 0) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    resetGraphRenderPositions(dataRef.current.nodes, totalNodeCount);
    renderer.graphData(dataRef.current).d3ReheatSimulation();
    scheduleFit(renderer, fitTimeoutRef, 420);
  }, [resetKey, totalNodeCount]);

  return (
    <div
      ref={containerRef}
      className="size-full bg-[radial-gradient(circle_at_center,var(--muted),transparent_70%)]"
    />
  );
}

function getActiveNodeIds() {
  return activeNodeIdsRefForAccessor.current;
}

const activeNodeIdsRefForAccessor: { current: Set<string> | null } = {
  current: null,
};

function getNodeColor(node: GraphRenderNode) {
  const activeNodeIds = getActiveNodeIds();
  return !activeNodeIds || activeNodeIds.has(node.id)
    ? node.color
    : NODE_DIMMED_COLOR;
}

function getLinkColor(link: GraphRenderLink) {
  const activeNodeIds = getActiveNodeIds();
  if (!activeNodeIds) return EDGE_COLOR;
  const sourceId = endpointId(link.source);
  const targetId = endpointId(link.target);
  return activeNodeIds.has(sourceId) && activeNodeIds.has(targetId)
    ? EDGE_FOCUS_COLOR
    : EDGE_DIMMED_COLOR;
}

function getNodeCanvasMode(node: GraphRenderNode) {
  return node.degree >= 7 || getActiveNodeIds()?.has(node.id)
    ? "after"
    : undefined;
}

function drawNodeLabel(
  node: GraphRenderNode,
  context: CanvasRenderingContext2D,
  globalScale: number,
) {
  if (node.x === undefined || node.y === undefined) return;
  const active = getActiveNodeIds()?.has(node.id) ?? false;
  if (!active && (node.degree < 7 || globalScale < 1.2)) return;

  const fontSize = 11 / globalScale;
  context.font = `500 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = "middle";
  const x = node.x + 4 / globalScale;
  const width = context.measureText(node.label).width;
  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.fillRect(
    x - 1 / globalScale,
    node.y - 7 / globalScale,
    width + 2 / globalScale,
    14 / globalScale,
  );
  context.fillStyle = NODE_LABEL_COLOR;
  context.fillText(node.label, x, node.y);
}

function scheduleFit(
  renderer: GraphRenderer,
  timeoutRef: { current: number | null },
  delay: number,
) {
  if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  timeoutRef.current = window.setTimeout(() => {
    timeoutRef.current = null;
    renderer.zoomToFit(420, 48);
  }, delay);
}

import type { LinkObject, NodeObject } from "force-graph";
import { knowledgeEdgeKey } from "../model/pagination";
import type { KnowledgeEdge, KnowledgeNode } from "../model/types";
import {
  knowledgeSpaceColorKey,
  knowledgeSpaceColorMap,
} from "./space-color";

export interface GraphRenderNode extends NodeObject {
  id: string;
  label: string;
  color: string;
  degree: number;
  connected: boolean;
  value: number;
}

export interface GraphRenderLink extends LinkObject<GraphRenderNode> {
  id: string;
}

interface OuterField {
  centerX: number;
  centerY: number;
  innerRadius: number;
  outerRadius: number;
}

export function buildGraphRenderData({
  nodes,
  edges,
  totalNodeCount,
  previousNodes,
}: {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  totalNodeCount: number;
  previousNodes: GraphRenderNode[];
}) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const spaceColors = knowledgeSpaceColorMap(
    nodes.map((node) => node.source.spaceId),
  );
  const readyEdges = edges.filter(
    (edge) =>
      edge.targetStatus === "ready" &&
      edge.targetId !== null &&
      nodeIds.has(edge.sourceId) &&
      nodeIds.has(edge.targetId),
  );
  const degrees = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  for (const edge of readyEdges) {
    const targetId = edge.targetId;
    if (!targetId) continue;
    degrees.set(edge.sourceId, (degrees.get(edge.sourceId) ?? 0) + 1);
    degrees.set(targetId, (degrees.get(targetId) ?? 0) + 1);
    addNeighbor(neighbors, edge.sourceId, targetId);
    addNeighbor(neighbors, targetId, edge.sourceId);
  }

  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const field = measureOuterField(
    previousNodes.filter((node) => (degrees.get(node.id) ?? 0) > 0),
    Math.max(0, totalNodeCount - degrees.size),
  );
  const graphNodes = nodes.map((node) => {
    const degree = degrees.get(node.id) ?? 0;
    const connected = degree > 0;
    const existing = previousById.get(node.id);
    const display = {
      label: node.title || node.source.path,
      color:
        spaceColors.get(knowledgeSpaceColorKey(node.source.spaceId)) ??
        SPACE_COLOR_FALLBACK,
      degree,
      connected,
      value: 0.9 + Math.min(Math.log2(degree + 1) * 0.82, 5.2),
    };

    if (existing) {
      const wasConnected = existing.connected;
      Object.assign(existing, display);
      if (connected && !wasConnected) {
        existing.fx = undefined;
        existing.fy = undefined;
      } else if (!connected && wasConnected) {
        const position = outerPlacement(node.id, field);
        Object.assign(existing, position, {
          fx: position.x,
          fy: position.y,
        });
      }
      return existing;
    }

    const position = connected
      ? coreStartPlacement(node.id, field)
      : outerPlacement(node.id, field);
    return {
      id: node.id,
      ...display,
      ...position,
      ...(!connected ? { fx: position.x, fy: position.y } : {}),
    };
  });
  const graphLinks = readyEdges.map((edge) => ({
    id: knowledgeEdgeKey(edge),
    source: edge.sourceId,
    target: edge.targetId!,
  }));

  return { nodes: graphNodes, links: graphLinks, neighbors };
}

const SPACE_COLOR_FALLBACK = "#64748b";

export function resetGraphRenderPositions(
  nodes: GraphRenderNode[],
  totalNodeCount = nodes.length,
) {
  const connectedNodes = nodes.filter((node) => node.connected);
  const field = measureOuterField(
    connectedNodes,
    Math.max(0, totalNodeCount - connectedNodes.length),
  );
  for (const node of nodes) {
    const position = node.connected
      ? coreStartPlacement(node.id, field)
      : outerPlacement(node.id, field);
    Object.assign(node, position, { vx: 0, vy: 0 });
    if (node.connected) {
      node.fx = undefined;
      node.fy = undefined;
    } else {
      node.fx = position.x;
      node.fy = position.y;
    }
  }
}

export function endpointId(
  endpoint: string | number | GraphRenderNode | undefined,
) {
  return typeof endpoint === "object" && endpoint !== null
    ? endpoint.id
    : String(endpoint ?? "");
}

function addNeighbor(
  neighbors: Map<string, Set<string>>,
  nodeId: string,
  neighborId: string,
) {
  const values = neighbors.get(nodeId) ?? new Set<string>();
  values.add(neighborId);
  neighbors.set(nodeId, values);
}

function measureOuterField(
  connectedNodes: GraphRenderNode[],
  orphanCount: number,
): OuterField {
  if (connectedNodes.length === 0) {
    const innerRadius = 150;
    return {
      centerX: 0,
      centerY: 0,
      innerRadius,
      outerRadius: Math.sqrt(innerRadius ** 2 + Math.max(orphanCount, 1) * 52),
    };
  }

  const centerX = average(connectedNodes.map((node) => node.x ?? 0));
  const centerY = average(connectedNodes.map((node) => node.y ?? 0));
  const radii = connectedNodes
    .map((node) => Math.hypot((node.x ?? 0) - centerX, (node.y ?? 0) - centerY))
    .sort((left, right) => left - right);
  const coreRadius = radii[Math.floor((radii.length - 1) * 0.95)] ?? 0;
  const innerRadius = Math.max(150, coreRadius * 1.24);
  return {
    centerX,
    centerY,
    innerRadius,
    outerRadius: Math.max(
      innerRadius * 1.72,
      Math.sqrt(innerRadius ** 2 + Math.max(orphanCount, 1) * 52),
    ),
  };
}

function coreStartPlacement(nodeId: string, field: OuterField) {
  const angle = hashUnit(nodeId, 17) * Math.PI * 2;
  const radius = 4 + Math.sqrt(hashUnit(nodeId, 29)) * 46;
  return {
    x: field.centerX + Math.cos(angle) * radius,
    y: field.centerY + Math.sin(angle) * radius,
  };
}

function outerPlacement(nodeId: string, field: OuterField) {
  const angle = hashUnit(nodeId, 43) * Math.PI * 2;
  const radialUnit = hashUnit(nodeId, 71);
  const radius = Math.sqrt(
    field.innerRadius ** 2 +
      radialUnit * (field.outerRadius ** 2 - field.innerRadius ** 2),
  );
  return {
    x: field.centerX + Math.cos(angle) * radius,
    y: field.centerY + Math.sin(angle) * radius,
  };
}

function hashUnit(value: string, salt: number) {
  let hash = (2_166_136_261 ^ salt) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0) / 4_294_967_296;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

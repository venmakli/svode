import type {
  AgentActivityMessageDto,
  AgentSessionDeltaDto,
  AgentSessionSnapshotDto,
} from "@/platform/agent-runtime/agent-runtime-api";

/** What one delivered message does to the local session activity. */
export type AgentActivityStep =
  | { kind: "state"; state: AgentSessionSnapshotDto }
  /** A duplicate of an applied delta. */
  | { kind: "unchanged" }
  /** A seq gap: drop the local state and subscribe again. */
  | { kind: "resubscribe" };

/**
 * Applies a delivered message to the local activity. A snapshot replaces the
 * state; a delta applies only with seq = current + 1.
 */
export function applyAgentActivityMessage(
  current: AgentSessionSnapshotDto | null,
  message: AgentActivityMessageDto,
): AgentActivityStep {
  if (message.type === "snapshot") {
    return { kind: "state", state: message.value };
  }
  const delta = message.value;
  if (!current) return { kind: "resubscribe" };
  if (delta.seq <= current.seq) return { kind: "unchanged" };
  if (delta.seq !== current.seq + 1) return { kind: "resubscribe" };
  return { kind: "state", state: applyChange(current, delta) };
}

function applyChange(
  current: AgentSessionSnapshotDto,
  delta: AgentSessionDeltaDto,
): AgentSessionSnapshotDto {
  const next = { ...current, seq: delta.seq };
  switch (delta.change) {
    case "item": {
      const item = delta.value;
      const index = current.items.findIndex((known) => known.id === item.id);
      next.items =
        index === -1
          ? [...current.items, item]
          : current.items.map((known, at) => (at === index ? item : known));
      return next;
    }
    case "turn":
      return { ...next, turn: delta.value };
    case "pending":
      return {
        ...next,
        pending: delta.value.state === "pending" ? delta.value : null,
      };
    case "history":
      return { ...next, history: delta.value };
    case "truncated": {
      const evicted = new Set(delta.value.itemIds);
      return {
        ...next,
        items: current.items.filter((item) => !evicted.has(item.id)),
        history: delta.value.history,
      };
    }
    case "connection":
      return { ...next, connection: delta.value };
    case "writer":
      return { ...next, writer: delta.value };
    case "settings":
      return { ...next, settings: delta.value };
    case "title":
      return { ...next, title: delta.value };
  }
}

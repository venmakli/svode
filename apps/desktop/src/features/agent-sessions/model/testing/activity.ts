import type { AgentSessionSnapshotDto } from "@/platform/agent-runtime/agent-runtime-api";

export function activitySnapshot(
  overrides: Partial<AgentSessionSnapshotDto> = {},
): AgentSessionSnapshotDto {
  return {
    seq: 0,
    session: { agent: "codex", namespace: "native", sessionId: "s1" },
    connection: "ready",
    turn: {
      turnId: null,
      phase: "none",
      lastOutcome: null,
      status: {
        state: "idle",
        stopReason: null,
        source: "svode_runtime",
        confidence: "exact",
      },
    },
    items: [],
    plan: null,
    pending: null,
    history: { source: "live", available: true, truncatedItems: null },
    writer: "acp",
    ...overrides,
  };
}

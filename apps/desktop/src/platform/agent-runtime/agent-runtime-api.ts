import {
  invokeCommand as invoke,
  NativeChannel,
} from "@/platform/native/invoke";

/** Canonical session identity: the agent's namespace plus its session id. */
export interface AgentSessionKeyDto {
  agent: string;
  namespace: "native" | "acp";
  sessionId: string;
}

export type AgentConnectionStateDto =
  | "not_connected"
  | "starting"
  | "ready"
  | "degraded"
  | "closed";

export type AgentWriterStateDto = "none" | "acp" | "pty";

export type AgentStopReasonDto =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "error"
  | "interrupted";

export type AgentInteractionKindDto = "permission" | "question";

export type AgentSessionStatusDto = (
  | { state: "running" }
  | { state: "requires_action"; request: AgentInteractionKindDto }
  | { state: "idle"; stopReason: AgentStopReasonDto | null }
  | { state: "unknown" }
) & {
  source: "svode_runtime" | "managed_pty" | "native_status_reader" | "none";
  confidence: "exact" | "approximate";
};

export interface AgentTurnStateDto {
  /** The current turn, or the last one once it ended. */
  turnId: string | null;
  phase: "none" | "running" | "cancelling";
  lastOutcome: AgentStopReasonDto | null;
  status: AgentSessionStatusDto;
}

export interface AgentHistoryStateDto {
  source: "live" | "replay" | "none";
  available: boolean;
  /** Number of evicted items when the retained history is truncated. */
  truncatedItems: number | null;
}

export type AgentToolKindDto =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AgentActivityItemDto = (
  | { kind: "user_message" }
  | { kind: "agent_message" }
  | { kind: "reasoning" }
  | { kind: "tool_call"; tool: AgentToolKindDto }
  | { kind: "mode_change" }
  | { kind: "config_change" }
  | { kind: "usage" }
  | { kind: "turn_outcome"; reason: AgentStopReasonDto }
  | { kind: "error" }
  | { kind: "interrupted" }
  | { kind: "generic"; label: string }
) & {
  id: string;
  turnId: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | null;
  /** Bounded compact text; the full content is the detail. */
  summary: string;
  hasDetail: boolean;
};

export interface AgentPlanDto {
  entries: {
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }[];
}

export type AgentInteractionStateDto =
  | "pending"
  | "answered"
  | "cancelled"
  | "expired";

export interface AgentChoiceOptionDto {
  id: string;
  label: string;
  description: string | null;
}

export type AgentFieldInputDto =
  | {
      type: "text";
      default: string | null;
      minLength: number | null;
      maxLength: number | null;
      format: string | null;
      pattern: string | null;
    }
  | {
      type: "number";
      default: number | null;
      minimum: number | null;
      maximum: number | null;
    }
  | {
      type: "integer";
      default: number | null;
      minimum: number | null;
      maximum: number | null;
    }
  | { type: "boolean"; default: boolean | null }
  | {
      type: "single_choice";
      options: AgentChoiceOptionDto[];
      default: string | null;
    }
  | {
      type: "multiple_choice";
      options: AgentChoiceOptionDto[];
      default: string[];
      minItems: number | null;
      maxItems: number | null;
    };

export interface AgentQuestionFieldDto {
  id: string;
  title: string;
  description: string | null;
  required: boolean;
  input: AgentFieldInputDto;
}

export interface AgentPendingInteractionDto {
  /** Runtime-assigned, unique within the session. */
  id: string;
  kind: AgentInteractionKindDto;
  title: string;
  /** Permission options; empty for a question. */
  options: {
    id: string;
    label: string;
    kind:
      | "allow_once"
      | "allow_always"
      | "reject_once"
      | "reject_always"
      | "other";
  }[];
  /** Question fields in the agent's order; empty for a permission. */
  fields: AgentQuestionFieldDto[];
  state: AgentInteractionStateDto;
}

export type AgentSettingCategoryDto =
  | "mode"
  | "model"
  | "thought_level"
  | "other";

/** A session setting the agent declared, in its order. */
export interface AgentSessionSettingDto {
  id: string;
  name: string;
  description: string | null;
  category: AgentSettingCategoryDto;
  /** Confirmed by the agent. */
  currentValue: string;
  options: { value: string; name: string; description: string | null }[];
}

export interface AgentSessionSnapshotDto {
  seq: number;
  session: AgentSessionKeyDto;
  connection: AgentConnectionStateDto;
  turn: AgentTurnStateDto;
  items: AgentActivityItemDto[];
  plan: AgentPlanDto | null;
  pending: AgentPendingInteractionDto | null;
  history: AgentHistoryStateDto;
  writer: AgentWriterStateDto;
  settings: AgentSessionSettingDto[];
}

/** Exactly one change with seq = previous + 1. */
export type AgentSessionDeltaDto = { seq: number } & (
  | { change: "item"; value: AgentActivityItemDto }
  | { change: "plan"; value: AgentPlanDto }
  | { change: "turn"; value: AgentTurnStateDto }
  /** A non-`pending` state clears the pending interaction. */
  | { change: "pending"; value: AgentPendingInteractionDto }
  | { change: "history"; value: AgentHistoryStateDto }
  /** Retention evicted these items; the history carries the marker. */
  | {
      change: "truncated";
      value: { itemIds: string[]; history: AgentHistoryStateDto };
    }
  | { change: "connection"; value: AgentConnectionStateDto }
  | { change: "writer"; value: AgentWriterStateDto }
  /** Replaces the whole set of session settings. */
  | { change: "settings"; value: AgentSessionSettingDto[] }
);

/** The snapshot first, then the deltas after it in seq order. */
export type AgentActivityMessageDto =
  | { type: "snapshot"; value: AgentSessionSnapshotDto }
  | { type: "delta"; value: AgentSessionDeltaDto };

export type AgentDetailBlockDto =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  /** An agent-side terminal; display only. */
  | { type: "terminal"; terminalId: string };

export type AgentDetailOutcomeDto =
  | { outcome: "available"; blocks: AgentDetailBlockDto[] }
  | {
      outcome: "unavailable";
      reason: "too_large" | "not_provided" | "released";
    }
  | { outcome: "error"; message: string };

export type AgentInteractionAnswerDto =
  | { type: "option"; optionId: string }
  | {
      type: "form";
      values: Record<string, boolean | number | string | string[]>;
    }
  | { type: "decline" };

export type AgentAnswerOutcomeDto =
  | { outcome: "accepted" }
  /** Nothing was sent; `state` is null for an unknown interaction. */
  | { outcome: "not_pending"; state: AgentInteractionStateDto | null };

/** Code of a typed runtime refusal, e.g. `turn_active` or `invalid_answer`. */
export type AgentRuntimeErrorCode =
  | "spawn"
  | "initialize"
  | "connection_not_found"
  | "connection_closed"
  | "session_not_found"
  | "turn_active"
  | "invalid_answer"
  | "auth_required"
  | "timeout"
  | "agent"
  | "protocol";

export function agentRuntimeErrorCode(
  error: unknown,
): AgentRuntimeErrorCode | null {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    error.kind === "agent_runtime" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code as AgentRuntimeErrorCode;
  }
  return null;
}

/** Opens a delivery of the session's activity; resolves to its id. */
export function subscribeAgentSession(
  session: AgentSessionKeyDto,
  onMessage: (message: AgentActivityMessageDto) => void,
): Promise<number> {
  const channel = new NativeChannel<AgentActivityMessageDto>(onMessage);
  return invoke<number>("agent_runtime_subscribe", { session, channel });
}

export function unsubscribeAgentSession(subscription: number): Promise<void> {
  return invoke<void>("agent_runtime_unsubscribe", { subscription });
}

export function readAgentActivityDetail(
  session: AgentSessionKeyDto,
  itemId: string,
): Promise<AgentDetailOutcomeDto> {
  return invoke<AgentDetailOutcomeDto>("agent_runtime_detail", {
    session,
    itemId,
  });
}

/** Resolves to the turn id once the runtime accepted the prompt. */
export function promptAgentSession(
  session: AgentSessionKeyDto,
  text: string,
): Promise<string> {
  return invoke<string>("agent_runtime_prompt", { session, text });
}

export function cancelAgentTurn(session: AgentSessionKeyDto): Promise<void> {
  return invoke<void>("agent_runtime_cancel", { session });
}

export function answerAgentInteraction(
  session: AgentSessionKeyDto,
  interaction: string,
  answer: AgentInteractionAnswerDto,
): Promise<AgentAnswerOutcomeDto> {
  return invoke<AgentAnswerOutcomeDto>("agent_runtime_answer", {
    session,
    interaction,
    answer,
  });
}

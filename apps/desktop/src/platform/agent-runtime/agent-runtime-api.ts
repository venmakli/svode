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
  /** Number of whole turns among them; items outside a turn do not count. */
  truncatedTurns: number | null;
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

/** A file a tool call works with, by its absolute path. */
export interface AgentToolLocationDto {
  path: string;
  /** How the call changes the file, when that is known. */
  change: "created" | "modified" | "deleted" | "moved" | null;
  /** Lines the call's diffs of the file add and remove; null without a diff. */
  lines: { added: number; removed: number } | null;
}

/** One MCP call a tool call is, recognized by the form of its agent. */
export interface AgentMcpCallDto {
  server: string;
  tool: string;
  /** A call of the Svode MCP server whose tool changes the project. */
  changesProject: boolean;
}

export interface AgentPlanEntryDto {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

/** One part of a user message in the order it was written. */
export type AgentMessageSegmentDto =
  | { type: "text"; text: string }
  /** A link to a file; `uri` is a `file://` URI for local files. */
  | { type: "link"; uri: string; name: string }
  | { type: "image"; uri: string | null; name: string | null };

export type AgentMediaKindDto = "image" | "video" | "audio" | "file";

/**
 * A file or media of an agent message or a tool call. Its data is never in
 * the snapshot: a segment with `hasData` is read by item and segment id.
 */
export interface AgentMediaSegmentDto {
  /** Unique within the item. */
  id: string;
  /** From the agent's MIME type, else from the file extension. */
  kind: AgentMediaKindDto;
  name: string | null;
  mimeType: string | null;
  /** Absolute path of the local file. */
  path: string | null;
  /** Size in bytes the agent reported, or that of the data. */
  size: number | null;
  /** The runtime holds the data the agent sent without a file. */
  hasData: boolean;
  /** In an agent message, the place in its text in UTF-16 code units. */
  offset: number | null;
}

/** A prompt part: text, or a link to a file by its absolute path. */
export type AgentPromptPartDto =
  | { type: "text"; text: string }
  | { type: "file"; path: string; name: string };

export type AgentActivityItemDto =
  /**
   * The summary is the text; `segments` is the whole message in order once
   * it links a file or an image, empty for a text-only message.
   */
  (
    | { kind: "user_message"; segments: AgentMessageSegmentDto[] }
    /** `media` stand at their places in the text, in order. */
    | { kind: "agent_message"; media: AgentMediaSegmentDto[] }
    | { kind: "reasoning" }
    /** `media` holds what the call produced or showed, in order. */
    | {
        kind: "tool_call";
        tool: AgentToolKindDto;
        media: AgentMediaSegmentDto[];
        /** Without repeats, in order of first appearance. */
        locations: AgentToolLocationDto[];
        mcpCalls: AgentMcpCallDto[];
      }
    | { kind: "mode_change" }
    | { kind: "config_change" }
    /** The turn's plan; a later plan of the turn replaces it in place. */
    | { kind: "plan"; entries: AgentPlanEntryDto[] }
    /** A resolved request; a permission belongs to its tool call row. */
    | {
        kind: "interaction";
        request: AgentInteractionKindDto;
        state: AgentInteractionStateDto;
        toolCallId: string | null;
        option: string | null;
        declined: boolean;
      }
    | {
        kind: "turn_outcome";
        reason: AgentStopReasonDto;
        durationMs: number | null;
      }
    | { kind: "error" }
    | { kind: "interrupted"; durationMs: number | null }
    | { kind: "generic"; label: string }
  ) & {
    id: string;
    turnId: string | null;
    status: "pending" | "in_progress" | "completed" | "failed" | null;
    /** Bounded compact text; the full content is the detail. */
    summary: string;
    hasDetail: boolean;
  };

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
  /** The tool call a permission is for; its item carries the subject. */
  toolCallId: string | null;
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

/** A slash command the agent declared; it goes to the agent as prompt text. */
export interface AgentSessionCommandDto {
  name: string;
  description: string;
  /** The agent's hint for the input after the command. */
  hint: string | null;
}

/** The agent's last report of its context window. */
export interface AgentSessionUsageDto {
  /** Tokens currently in the context. */
  used: number;
  /** Size of the context window. */
  size: number;
  /** Cumulative cost of the session; `currency` is an ISO 4217 code. */
  cost: { amount: number; currency: string } | null;
}

export interface AgentSessionSnapshotDto {
  seq: number;
  session: AgentSessionKeyDto;
  connection: AgentConnectionStateDto;
  turn: AgentTurnStateDto;
  items: AgentActivityItemDto[];
  pending: AgentPendingInteractionDto | null;
  history: AgentHistoryStateDto;
  writer: AgentWriterStateDto;
  settings: AgentSessionSettingDto[];
  /** The slash commands the agent offers now. */
  commands: AgentSessionCommandDto[];
  usage: AgentSessionUsageDto | null;
  /** The session title the agent reported. */
  title: string | null;
}

/** Exactly one change with seq = previous + 1. */
export type AgentSessionDeltaDto = { seq: number } & (
  | { change: "item"; value: AgentActivityItemDto }
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
  /** Replaces the whole set of slash commands. */
  | { change: "commands"; value: AgentSessionCommandDto[] }
  | { change: "usage"; value: AgentSessionUsageDto }
  | { change: "title"; value: string }
);

/** The snapshot first, then the deltas after it in seq order. */
export type AgentActivityMessageDto =
  | { type: "snapshot"; value: AgentSessionSnapshotDto }
  | { type: "delta"; value: AgentSessionDeltaDto };

export type AgentDetailBlockDto =
  | { type: "text"; text: string }
  /** Text beyond the per-item bound: its head and tail with the number of characters omitted between them. */
  | { type: "excerpt"; head: string; omittedChars: number; tail: string }
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

export type AgentMediaOutcomeDto =
  /** `data` is base64. */
  | { outcome: "available"; mimeType: string; data: string }
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
  | "connection_taken"
  | "open_unsupported"
  | "read_only_unsupported"
  | "writer_required"
  | "list_unsupported"
  | "file_unavailable"
  | "turn_active"
  | "invalid_answer"
  | "auth_required"
  | "writer_refused"
  | "setting_refused"
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

/** Why a setting value did not apply (`setting_refused`). */
export interface AgentSettingRefusalDto {
  setting: string;
  value: string;
  reason: { kind: "not_declared" } | { kind: "agent"; message: string };
}

export function agentSettingRefusal(
  error: unknown,
): AgentSettingRefusalDto | null {
  if (agentRuntimeErrorCode(error) !== "setting_refused") return null;
  const refusal = error as Partial<AgentSettingRefusalDto>;
  if (
    typeof refusal.setting !== "string" ||
    typeof refusal.value !== "string" ||
    !refusal.reason
  ) {
    return null;
  }
  return {
    setting: refusal.setting,
    value: refusal.value,
    reason: refusal.reason,
  };
}

export interface AgentInfoDto {
  name: string | null;
  version: string | null;
  capabilities: {
    loadSession: boolean;
    listSessions: boolean;
    resumeSession: boolean;
    closeSession: boolean;
  };
}

/** Why an agent cannot start now; each is its own recoverable outcome. */
export type AgentLaunchUnavailableDto =
  | { code: "disabled" }
  | { code: "executable_missing"; executable: string }
  | { code: "not_supported" }
  | { code: "node_missing"; required: number }
  | { code: "node_unsupported"; version: string; required: number }
  | { code: "node_unknown"; message: string }
  | { code: "adapter_not_installed" }
  | { code: "adapter_needs_update"; installedVersion: string }
  | { code: "cli_unsupported"; version: string; minimum: string };

export type AgentCheckDto =
  | { state: "ready"; agent: AgentInfoDto }
  | { state: "unavailable"; reason: AgentLaunchUnavailableDto }
  | { state: "auth_required"; message: string }
  | { state: "failed_to_start"; message: string };

/**
 * The user's explicit check of an agent: starts it, runs `initialize` and
 * closes it unless something else needs the connection.
 */
export function checkAgent(agent: string): Promise<AgentCheckDto> {
  return invoke<AgentCheckDto>("agent_runtime_check", { agent });
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

/** The data of a media segment the runtime holds for an item. */
export function readAgentMedia(
  session: AgentSessionKeyDto,
  itemId: string,
  segmentId: string,
): Promise<AgentMediaOutcomeDto> {
  return invoke<AgentMediaOutcomeDto>("agent_runtime_media", {
    session,
    itemId,
    segmentId,
  });
}

/** Resolves to the turn id once the runtime accepted the prompt. */
export function promptAgentSession(
  session: AgentSessionKeyDto,
  prompt: AgentPromptPartDto[],
): Promise<string> {
  return invoke<string>("agent_runtime_prompt", { session, prompt });
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

/** What Svode knows about a process outside it writing to the session. */
export type AgentExternalLivenessDto = "free" | "external_active" | "unknown";

/** What opening an existing session in the chat did. */
export type AgentSessionOpeningDto =
  /** The snapshot's writer tells whether the runtime drives or only read it. */
  | {
      outcome: "opened";
      session: AgentSessionKeyDto;
      liveness: AgentExternalLivenessDto;
    }
  /** Attaching needs the user's confirmation of this attempt. */
  | { outcome: "confirmation_required" }
  | { outcome: "external_active" }
  /** A managed terminal of Svode drives the session. */
  | { outcome: "terminal_active" }
  | { outcome: "unsupported" }
  | { outcome: "unavailable"; reason: AgentLaunchUnavailableDto }
  | { outcome: "auth_required"; message: string };

/**
 * Opens a listed session in the chat without sending a prompt; `attach` is
 * the user's confirmation of one attempt to attach it with the writer.
 */
export function openAgentSession(
  projectPath: string,
  sessionId: string,
  attach: boolean,
): Promise<AgentSessionOpeningDto> {
  return invoke<AgentSessionOpeningDto>("agent_runtime_open_session", {
    projectPath,
    sessionId,
    attach,
  });
}

/** The chat stops driving the session between turns. */
export function releaseAgentSession(
  session: AgentSessionKeyDto,
): Promise<void> {
  return invoke<void>("agent_runtime_release_session", { session });
}

/** A value for one declared session setting. */
export interface AgentSettingValueDto {
  setting: string;
  value: string;
}

/**
 * Changes a declared setting of the session; resolves once the agent
 * confirmed the value, which also arrives as a settings delta. A refusal
 * (`setting_refused`) keeps the value.
 */
export function setAgentSessionSetting(
  session: AgentSessionKeyDto,
  value: AgentSettingValueDto,
): Promise<void> {
  return invoke<void>("agent_runtime_set_setting", { session, value });
}

/** What a new session draft shows for its agent. */
export interface DraftAgentDto {
  /** Present while the ready agent's connection is held for the draft. */
  hold: number | null;
  check: AgentCheckDto;
  /**
   * The session the draft created without a prompt, where the agent leaves
   * nothing in its store for it: its settings and commands show in the
   * draft, and the first send goes to it.
   */
  session: AgentSessionKeyDto | null;
}

/**
 * A new session draft chose `agent` in the Space `cwd`: its connection
 * starts so the draft shows its readiness before the first prompt.
 */
export function holdDraftAgent(
  agent: string,
  cwd: string,
): Promise<DraftAgentDto> {
  return invoke<DraftAgentDto>("agent_runtime_hold_draft", { agent, cwd });
}

export function releaseDraftAgent(hold: number): Promise<void> {
  return invoke<void>("agent_runtime_release_draft", { hold });
}

export type StartedAgentSessionDto =
  | {
      outcome: "started";
      session: AgentSessionKeyDto;
      /** The catalogue id the session is listed under. */
      sessionId: string;
      turnId: string;
    }
  | { outcome: "unavailable"; reason: AgentLaunchUnavailableDto };

/**
 * The first send of a new session draft: the session the draft `hold`
 * created takes the prompt; otherwise a new session in `cwd` is created
 * with `settings` first.
 */
export function startAgentSession(request: {
  agent: string;
  cwd: string;
  settings: AgentSettingValueDto[];
  prompt: AgentPromptPartDto[];
  hold: number | null;
}): Promise<StartedAgentSessionDto> {
  return invoke<StartedAgentSessionDto>("agent_runtime_start_session", request);
}

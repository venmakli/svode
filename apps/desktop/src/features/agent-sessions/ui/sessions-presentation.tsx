import {
  BotMessageSquare,
  Copy,
  ListChecks,
  Pin,
  SquarePlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { AgentAdapterDictionary } from "@/features/agent-adapters";
import {
  defineCollectionPresentation,
  type CollectionActionState,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type { AgentSessionsListResult } from "../api";
import {
  agentSessionLastActivityAt,
  compareAgentSessionsByDefault,
  type AgentSession,
} from "../model";
import { ExternalTerminalIcon } from "./external-terminal-icon";
import {
  STATUS_OPTIONS,
  statusLabel,
  statusText,
  statusValueLabel,
} from "./session-status";
import * as m from "@/paraglide/messages.js";

export const AGENT_SESSIONS_PRESENTATION_ID = "all";

export interface AgentSessionsPresentationActions {
  createState: CollectionActionState;
  onCreate(): Promise<void>;
  /** The live terminal of a session, when it has one. */
  terminalOf(session: AgentSession): string | null;
  onCloseTerminal(session: AgentSession): void;
  onCopyResumeCommand(session: AgentSession): void;
  onOpenExternalTerminal(session: AgentSession): void;
  /** The Routine that launched a session, when one did. */
  routineOf(session: AgentSession): RoutineLaunchLink | null;
  onOpenRoutine(routine: RoutineLaunchLink): void;
  /** Whether a session is pinned; null when it cannot be pinned yet. */
  pinnedOf(session: AgentSession): boolean | null;
  pinPending(session: AgentSession): boolean;
  onTogglePin(session: AgentSession): void;
  /** Whether "Keep in Now" applies: it has an identity, not pinned or kept. */
  keepable(session: AgentSession): boolean;
  onKeep(session: AgentSession): void;
}

export function createAgentSessionsPresentation({
  actions,
  agents,
  onActivate,
  state,
}: {
  actions: AgentSessionsPresentationActions;
  agents: AgentAdapterDictionary;
  onActivate: CollectionPresentationDescriptor<AgentSession>["onActivate"];
  state: CollectionPresentationState<AgentSession>;
}) {
  return defineCollectionPresentation({
    descriptor: createAgentSessionsPresentationDescriptor({
      actions,
      agents,
      onActivate,
      rows: state.phase === "ready" ? state.rows : [],
    }),
    state,
  });
}

export function createAgentSessionsPresentationDescriptor({
  actions,
  agents,
  onActivate,
  rows,
}: {
  actions: AgentSessionsPresentationActions;
  agents: AgentAdapterDictionary;
  onActivate?: CollectionPresentationDescriptor<AgentSession>["onActivate"];
  rows: readonly AgentSession[];
}): CollectionPresentationDescriptor<AgentSession> {
  const routineName = (row: AgentSession) =>
    actions.routineOf(row)?.name ?? null;
  const routineOptions = [
    ...new Set(rows.flatMap((row) => routineName(row) ?? [])),
  ].map((name) => ({ color: "neutral" as const, name }));
  const properties: readonly CollectionPropertyDefinition<AgentSession>[] = [
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-sessions",
      getValue: (row) => agents.label(row.source),
      key: "agent",
      label: m.sessions_field_agent(),
      standard: {
        options: agents.options(rows.map((row) => row.source)),
        type: "select",
      },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-sessions",
      getValue: statusLabel,
      key: "status",
      label: m.sessions_field_status(),
      standard: {
        options: STATUS_OPTIONS.map((option) => ({
          color: option.color,
          name: statusValueLabel(option.value),
        })),
        type: "select",
      },
    }),
    defineOwnerDefinedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-sessions",
      getValue: routineName,
      key: "routine",
      label: m.sessions_field_routine(),
      standard: { options: routineOptions, type: "select" },
    }),
    defineComputedCollectionProperty({
      capabilities: {
        filter: { kind: "standard" },
        sort: { kind: "standard" },
      },
      featureId: "agent-sessions",
      getValue: agentSessionLastActivityAt,
      key: "last-activity",
      label: m.sessions_field_last_activity(),
      standard: { display: "medium", type: "date" },
    }),
  ];

  return {
    create: {
      label: m.sessions_action_new(),
      intents: [
        {
          getState: () => actions.createState,
          id: "new-session",
          label: m.sessions_action_new(),
          run: actions.onCreate,
        },
      ],
    },
    onActivate,
    properties,
    getRowId: (row) => row.id,
    id: AGENT_SESSIONS_PRESENTATION_ID,
    label: m.sessions_presentation_all(),
    layout: {
      density: "compact",
      getTitle: (row) => row.title,
      kind: "list",
      renderLeading: () => (
        <BotMessageSquare className="size-4 text-muted-foreground" />
      ),
      visibleProperties: ["status", "agent", "routine", "last-activity"],
    },
    query: {
      defaultCompare: compareAgentSessionsByDefault,
      getSearchText: (row) =>
        `${row.title} ${agents.label(row.source)} ${statusText(row)} ${routineName(row) ?? ""}`,
    },
    rowActions: [
      {
        getLabel: (row) =>
          actions.pinnedOf(row) ? m.navigation_unpin() : m.navigation_pin(),
        getState: (row) =>
          actions.pinPending(row) ? { status: "pending" } : { status: "idle" },
        icon: <Pin />,
        id: "pin",
        isVisible: (row) => actions.pinnedOf(row) !== null,
        label: m.navigation_pin(),
        run: actions.onTogglePin,
      },
      {
        getState: (row) =>
          actions.pinPending(row) ? { status: "pending" } : { status: "idle" },
        icon: <SquarePlus />,
        id: "keep",
        isVisible: actions.keepable,
        label: m.navigation_keep(),
        run: actions.onKeep,
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <ListChecks />,
        id: "open-routine",
        isVisible: (row) => actions.routineOf(row)?.definitionPresent === true,
        label: m.sessions_action_open_routine(),
        run: (row) => {
          const routine = actions.routineOf(row);
          if (routine?.definitionPresent) actions.onOpenRoutine(routine);
        },
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <X />,
        id: "close-terminal",
        isVisible: (row) => actions.terminalOf(row) !== null,
        label: m.sessions_action_close_terminal(),
        run: actions.onCloseTerminal,
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <Copy />,
        id: "copy-resume-command",
        isVisible: (row) => Boolean(row.resumeCommand),
        label: m.sessions_action_copy_resume_command(),
        run: actions.onCopyResumeCommand,
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <ExternalTerminalIcon />,
        id: "open-external-terminal",
        isVisible: (row) => Boolean(row.resumeCommand?.cwd ?? row.cwd),
        label: m.sessions_action_open_external_terminal(),
        run: actions.onOpenExternalTerminal,
      },
    ],
  };
}

interface AgentSessionsCatalogView {
  result: AgentSessionsListResult | null;
  error: string | null;
  refreshing: boolean;
  rows: readonly AgentSession[] | null;
}

/**
 * Collection state over the catalog: rows stay while a source is partly
 * unavailable or a refresh failed (see agentSessionsSourceProblem); without
 * any list the failure blocks.
 */
export function toAgentSessionsPresentationState(
  catalog: AgentSessionsCatalogView,
  agents: AgentAdapterDictionary,
  recovery: { onRetry(): void; onOpenSettings(): void },
): CollectionPresentationState<AgentSession> {
  const { result, error, refreshing, rows } = catalog;
  const recoveryActions = (
    <SessionsRecoveryActions disabled={refreshing} {...recovery} />
  );
  if (!result) {
    if (!error) return { phase: "initial" };
    return {
      error: (
        <div className="flex flex-col items-start gap-2">
          <span className="flex flex-col gap-1">
            <strong>{m.sessions_source_unavailable_title()}</strong>
            <span>{error ?? m.sessions_source_unavailable_description()}</span>
          </span>
          {recoveryActions}
        </div>
      ),
      phase: "blocking_error",
    };
  }
  if (!rows || !agents.ready) return { phase: "initial" };

  return {
    diagnostics: [],
    phase: "ready",
    rows,
    sourceEmpty: <SessionsEmpty />,
  };
}

/**
 * The problem of a listed catalog, shown by the toolbar diagnostics: a partly
 * unavailable source or a failed refresh.
 */
export function agentSessionsSourceProblem(
  catalog: Pick<AgentSessionsCatalogView, "result" | "error">,
  agents: AgentAdapterDictionary,
): string | null {
  const { result, error } = catalog;
  if (!result) return null;
  if (error) return error;
  return result.status === "partial"
    ? partialSourcesMessage(result, agents)
    : null;
}

function partialSourcesMessage(
  result: AgentSessionsListResult,
  agents: AgentAdapterDictionary,
) {
  const unavailable = [
    ...new Set(
      result.sources
        .filter((source) => source.status !== "ok")
        .map((source) => agents.label(source.source)),
    ),
  ];
  return unavailable.length > 0
    ? m.sessions_source_partial({ agents: unavailable.join(", ") })
    : m.sessions_source_unavailable_description();
}

function SessionsRecoveryActions({
  disabled,
  onRetry,
  onOpenSettings,
}: {
  disabled: boolean;
  onRetry(): void;
  onOpenSettings(): void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onRetry}
      >
        {m.sessions_action_retry()}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onOpenSettings}>
        {m.sessions_action_open_settings()}
      </Button>
    </div>
  );
}

function SessionsEmpty() {
  return (
    <Empty className="min-h-48 flex-none border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BotMessageSquare />
        </EmptyMedia>
        <EmptyTitle>{m.sessions_collection_empty_title()}</EmptyTitle>
        <EmptyDescription>
          {m.sessions_collection_empty_description()} {m.sessions_device_note()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

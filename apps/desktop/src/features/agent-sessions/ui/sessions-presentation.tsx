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
import {
  defineAgentCollectionProperty,
  type AgentAdapterDictionary,
} from "@/features/agent-adapters";
import {
  defineCollectionPresentation,
  type CollectionActionState,
  type CollectionPresentationDescriptor,
  type CollectionPresentationState,
} from "@/features/collection";
import {
  defineComputedCollectionProperty,
  defineOwnerDefinedCollectionProperty,
  defineTitleCollectionProperty,
  defineUpdatedCollectionProperty,
  type CollectionPropertyDefinition,
} from "@/features/properties";
import type { RoutineLaunchLink } from "@/features/routines/catalog";
import type { AgentSessionsListResult } from "../api";
import { compareAgentSessionsByDefault, type AgentSession } from "../model";
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
      items: state.phase === "ready" ? state.items : [],
    }),
    state,
  });
}

export function createAgentSessionsPresentationDescriptor({
  actions,
  agents,
  onActivate,
  items,
}: {
  actions: AgentSessionsPresentationActions;
  agents: AgentAdapterDictionary;
  onActivate?: CollectionPresentationDescriptor<AgentSession>["onActivate"];
  items: readonly AgentSession[];
}): CollectionPresentationDescriptor<AgentSession> {
  const routineName = (item: AgentSession) =>
    actions.routineOf(item)?.name ?? null;
  const routineOptions = [
    ...new Set(items.flatMap((item) => routineName(item) ?? [])),
  ].map((name) => ({ color: "neutral" as const, name }));
  const properties: readonly CollectionPropertyDefinition<AgentSession>[] = [
    defineTitleCollectionProperty({ getValue: (item) => item.title }),
    defineAgentCollectionProperty({
      agents,
      getAgent: (item) => ({ agent: item.source, kind: "agent" }),
      items,
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
    defineUpdatedCollectionProperty({
      getValue: (session) => session.lastActivityAt,
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
    getItemId: (item) => item.id,
    id: AGENT_SESSIONS_PRESENTATION_ID,
    label: m.sessions_presentation_all(),
    layout: {
      density: "compact",
      getTitle: (item) => item.title,
      kind: "list",
      renderLeading: () => (
        <BotMessageSquare className="size-4 text-muted-foreground" />
      ),
      visibleProperties: ["status", "agent", "routine", "updated"],
    },
    query: {
      defaultCompare: compareAgentSessionsByDefault,
      getSearchText: (item) =>
        `${item.title} ${agents.label(item.source)} ${statusText(item)} ${routineName(item) ?? ""}`,
    },
    itemActions: [
      {
        getLabel: (item) =>
          actions.pinnedOf(item) ? m.navigation_unpin() : m.navigation_pin(),
        getState: (item) =>
          actions.pinPending(item) ? { status: "pending" } : { status: "idle" },
        icon: <Pin />,
        id: "pin",
        isVisible: (item) => actions.pinnedOf(item) !== null,
        label: m.navigation_pin(),
        run: actions.onTogglePin,
      },
      {
        getState: (item) =>
          actions.pinPending(item) ? { status: "pending" } : { status: "idle" },
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
        isVisible: (item) =>
          actions.routineOf(item)?.definitionPresent === true,
        label: m.sessions_action_open_routine(),
        run: (item) => {
          const routine = actions.routineOf(item);
          if (routine?.definitionPresent) actions.onOpenRoutine(routine);
        },
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <X />,
        id: "close-terminal",
        isVisible: (item) => actions.terminalOf(item) !== null,
        label: m.sessions_action_close_terminal(),
        run: actions.onCloseTerminal,
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <Copy />,
        id: "copy-resume-command",
        isVisible: (item) => Boolean(item.resumeCommand),
        label: m.sessions_action_copy_resume_command(),
        run: actions.onCopyResumeCommand,
      },
      {
        getState: () => ({ status: "idle" }),
        icon: <ExternalTerminalIcon />,
        id: "open-external-terminal",
        isVisible: (item) => Boolean(item.resumeCommand?.cwd ?? item.cwd),
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
  items: readonly AgentSession[] | null;
}

/**
 * Collection state over the catalog: items stay while a source is partly
 * unavailable or a refresh failed (see agentSessionsSourceProblem); without
 * any list the failure blocks.
 */
export function toAgentSessionsPresentationState(
  catalog: AgentSessionsCatalogView,
  agents: AgentAdapterDictionary,
  recovery: { onRetry(): void; onOpenSettings(): void },
): CollectionPresentationState<AgentSession> {
  const { result, error, refreshing, items } = catalog;
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
  if (!items || !agents.ready) return { phase: "initial" };

  return {
    diagnostics: [],
    phase: "ready",
    items,
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

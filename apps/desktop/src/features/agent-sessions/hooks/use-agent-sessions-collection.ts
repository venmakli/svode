import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  useCollectionState,
  type CollectionActionState,
  type CollectionInstance,
} from "@/features/collection";
import {
  useRoutineLaunchLinks,
  type RoutineLaunchLink,
} from "@/features/routines/catalog";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { openSessionCwdInExternalTerminal } from "../api";
import {
  hasActionableWait,
  isAgentSessionInScope,
  type AgentSession,
  type AgentSessionOpenOptions,
  type AgentSessionTarget,
} from "../model";
import {
  AGENT_SESSIONS_PRESENTATION_ID,
  createAgentSessionsPresentation,
  toAgentSessionsPresentationState,
  type AgentSessionsPresentationActions,
} from "../ui/sessions-presentation";
import { useAgentSessionCatalog } from "./use-agent-session-catalog";
import { useAgentSessionScopes } from "./use-agent-session-scopes";
import { useStartAgentSession } from "./use-start-agent-session";
import * as m from "@/paraglide/messages.js";

export interface AgentSessionTerminalClose {
  session: AgentSession;
  ptyId: string;
}

/**
 * The "Sessions" collection of a registered Space: its own sessions from the
 * project catalog, opened in the session peek.
 */
export function useAgentSessionsCollection({
  owner,
  onOpenSession,
  onOpenAppSettings,
  onOpenRoutine,
}: {
  owner: ScopeOwnerRef;
  onOpenSession(
    target: AgentSessionTarget,
    options?: AgentSessionOpenOptions,
  ): void;
  onOpenAppSettings(): void;
  onOpenRoutine(routine: RoutineLaunchLink): void;
}) {
  const agents = useAgentAdapterDictionary();
  const scopes = useAgentSessionScopes();
  const result = useAgentSessionCatalog((state) => state.result);
  const sessions = useAgentSessionCatalog((state) => state.sessions);
  const error = useAgentSessionCatalog((state) => state.error);
  const loading = useAgentSessionCatalog((state) => state.loading);
  const refreshing = useAgentSessionCatalog((state) => state.refreshing);
  const terminals = useAgentSessionCatalog((state) => state.terminals);
  const reentryResults = useAgentSessionCatalog(
    (state) => state.reentryResults,
  );
  const load = useAgentSessionCatalog((state) => state.load);
  const closeCatalogTerminal = useAgentSessionCatalog(
    (state) => state.closeTerminal,
  );
  const startSession = useStartAgentSession();
  const [creating, setCreating] = useState(false);
  const [closeRequest, setCloseRequest] =
    useState<AgentSessionTerminalClose | null>(null);

  // Opening the collection asks the catalog for the full list.
  useEffect(() => {
    void load();
  }, [load]);

  const scope =
    scopes.find((candidate) => candidate.path === owner.spacePath) ?? null;
  const rows = useMemo(
    () =>
      scope
        ? sessions.filter((session) => isAgentSessionInScope(session, scope))
        : null,
    [scope, sessions],
  );
  const refresh = useCallback(() => load({ force: true }), [load]);
  const launchIds = useMemo(
    () => (rows ?? []).flatMap((session) => session.launchId ?? []),
    [rows],
  );
  // Each list read also re-reads the Routines of its launches.
  const routines = useRoutineLaunchLinks(
    owner.projectPath,
    launchIds,
    result?.generatedAt,
  );

  const terminalOf = useCallback(
    (session: AgentSession) =>
      session.runtime?.ptyId ??
      terminals[session.id]?.ptyId ??
      reentryResults[session.id]?.ptyId ??
      null,
    [reentryResults, terminals],
  );

  const closeTerminal = useCallback(
    ({ session, ptyId }: AgentSessionTerminalClose) => {
      void closeCatalogTerminal(session.id, ptyId).catch((closeError) => {
        toast.error(m.sessions_toast_close_terminal_failed(), {
          description: getNativeErrorMessage(closeError),
        });
      });
    },
    [closeCatalogTerminal],
  );

  const createState: CollectionActionState =
    creating || !scope ? { status: "pending" } : { status: "idle" };
  const actions: AgentSessionsPresentationActions = {
    createState,
    onCreate: async () => {
      if (creating) return;
      setCreating(true);
      try {
        const target = await startSession(owner.spacePath);
        // Starting a session is an explicit move into its terminal.
        if (target) onOpenSession(target, { focusTerminal: true });
      } finally {
        setCreating(false);
      }
    },
    terminalOf,
    onCloseTerminal: (session) => {
      const ptyId = terminalOf(session);
      if (!ptyId) return;
      // Closing the terminal of a working or waiting agent interrupts it.
      if (session.status === "active" || hasActionableWait(session)) {
        setCloseRequest({ session, ptyId });
      } else {
        closeTerminal({ session, ptyId });
      }
    },
    onCopyResumeCommand: (session) => {
      const command = session.resumeCommand?.display;
      if (!command) return;
      void navigator.clipboard
        .writeText(command)
        .then(() => toast.success(m.sessions_toast_command_copied()))
        .catch((copyError) => {
          toast.error(m.sessions_toast_command_copy_failed(), {
            description: getNativeErrorMessage(copyError),
          });
        });
    },
    routineOf: (session) =>
      (session.launchId && routines.get(session.launchId)) || null,
    onOpenRoutine,
    onOpenExternalTerminal: (session) => {
      const cwd = session.resumeCommand?.cwd ?? session.cwd;
      if (!cwd) return;
      void openSessionCwdInExternalTerminal(cwd).catch((openError) => {
        toast.error(m.sessions_toast_external_terminal_failed(), {
          description: getNativeErrorMessage(openError),
        });
      });
    },
  };

  const presentation = createAgentSessionsPresentation({
    actions,
    agents,
    onActivate: (row) =>
      onOpenSession({ sessionId: row.id, launchId: row.launchId ?? null }),
    state: toAgentSessionsPresentationState(
      { result, error, refreshing, rows },
      agents,
      { onRetry: () => void refresh(), onOpenSettings: onOpenAppSettings },
    ),
  });
  const instance: CollectionInstance = {
    defaultPresentationId: AGENT_SESSIONS_PRESENTATION_ID,
    instanceKey: `sessions:${owner.ownerKey}`,
    presentations: [presentation],
    stateScope: "session",
  };
  const collectionState = useCollectionState(instance);

  return {
    collectionState,
    instance,
    refresh,
    refreshing: refreshing || loading,
    closeRequest,
    confirmClose: () => {
      if (closeRequest) closeTerminal(closeRequest);
      setCloseRequest(null);
    },
    dismissClose: () => setCloseRequest(null),
  };
}

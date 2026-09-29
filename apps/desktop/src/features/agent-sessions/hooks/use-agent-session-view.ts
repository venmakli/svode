import { useCallback, useEffect, useState } from "react";
import {
  openSessionCwdInExternalTerminal,
  type AgentSessionReentryResult,
} from "../api";
import { commandDisplay } from "../lib";
import {
  hasActionableWait,
  resolveAgentSessionId,
  type AgentSession,
  type AgentSessionOpenOptions,
  type AgentSessionTarget,
} from "../model";
import { useAgentSessionCatalog } from "./use-agent-session-catalog";

export interface AgentSessionView {
  /** Catalog id the target resolves to after identity handoffs. */
  sessionId: string;
  session: AgentSession | null;
  ptyId: string | null;
  reentryResult: AgentSessionReentryResult | null;
  reentering: boolean;
  /** The target is not listed yet and no list since opening has been read. */
  checking: boolean;
  missing: boolean;
  /** The terminal shown for this session has ended while it was viewed. */
  terminalFinished: boolean;
  /** Focus belongs in the terminal: the user asked to continue there. */
  focusTerminal: boolean;
  /** An agent works or waits for the user, so closing its terminal interrupts it. */
  agentBusy: boolean;
  resumeCommand: string | null;
  externalTerminalCwd: string | null;
  continueInTerminal: () => void;
  closeTerminal: () => Promise<void>;
  openExternalTerminal: () => Promise<void>;
}

/** Resolves an already listed target without loading or observing it. */
export function useResolvedAgentSession(
  target: AgentSessionTarget | null,
): AgentSession | null {
  return useAgentSessionCatalog((state) => {
    if (!target) return null;
    const sessionId = resolveAgentSessionId(
      target,
      state.sessions,
      state.pendingHandoffs,
    );
    return state.sessions.find((session) => session.id === sessionId) ?? null;
  });
}

/**
 * One opened session over the project catalog. Viewing never starts the
 * agent: re-entry happens only through `continueInTerminal`.
 */
export function useAgentSessionView(
  target: AgentSessionTarget,
  { focusTerminal: focusOnOpen = false }: AgentSessionOpenOptions = {},
): AgentSessionView {
  const sessions = useAgentSessionCatalog((state) => state.sessions);
  const pendingHandoffs = useAgentSessionCatalog(
    (state) => state.pendingHandoffs,
  );
  const terminals = useAgentSessionCatalog((state) => state.terminals);
  const reentryResults = useAgentSessionCatalog(
    (state) => state.reentryResults,
  );
  const reenteringSessionIds = useAgentSessionCatalog(
    (state) => state.reenteringSessionIds,
  );
  const loadTarget = useAgentSessionCatalog((state) => state.loadTarget);
  const reenter = useAgentSessionCatalog((state) => state.reenter);
  const observeSession = useAgentSessionCatalog(
    (state) => state.observeSession,
  );
  const closeCatalogTerminal = useAgentSessionCatalog(
    (state) => state.closeTerminal,
  );

  const sessionId = resolveAgentSessionId(target, sessions, pendingHandoffs);
  const session = sessions.find((item) => item.id === sessionId) ?? null;
  const reentryResult = reentryResults[sessionId] ?? null;
  const ptyId =
    session?.runtime?.ptyId ??
    terminals[sessionId]?.ptyId ??
    reentryResult?.ptyId ??
    null;
  const reentering = reenteringSessionIds.has(sessionId);

  const { sessionId: targetSessionId, launchId: targetLaunchId } = target;
  const targetKey = `${targetSessionId}\n${targetLaunchId ?? ""}`;
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadTarget({
      sessionId: targetSessionId,
      launchId: targetLaunchId,
    }).finally(() => {
      if (!cancelled) setCheckedKey(targetKey);
    });
    return () => {
      cancelled = true;
    };
  }, [loadTarget, targetKey, targetLaunchId, targetSessionId]);
  const unresolved = !session && !ptyId;
  const checking = unresolved && checkedKey !== targetKey;

  const listed = session !== null;
  useEffect(() => {
    if (!listed) return;
    return observeSession(sessionId);
  }, [listed, observeSession, sessionId]);

  const [attachedPtyId, setAttachedPtyId] = useState<string | null>(null);
  if (ptyId && ptyId !== attachedPtyId) setAttachedPtyId(ptyId);
  const terminalFinished = !ptyId && attachedPtyId !== null;
  const [focusTerminal, setFocusTerminal] = useState(focusOnOpen);

  const continueInTerminal = useCallback(() => {
    if (!session) return;
    setAttachedPtyId(null);
    setFocusTerminal(true);
    void reenter(session);
  }, [reenter, session]);

  const closeTerminal = useCallback(async () => {
    if (!ptyId) return;
    await closeCatalogTerminal(sessionId, ptyId);
  }, [closeCatalogTerminal, ptyId, sessionId]);

  const externalTerminalCwd =
    reentryResult?.cwd ??
    reentryResult?.command?.cwd ??
    session?.resumeCommand?.cwd ??
    session?.cwd ??
    null;
  const openExternalTerminal = useCallback(async () => {
    if (!externalTerminalCwd) return;
    await openSessionCwdInExternalTerminal(externalTerminalCwd);
  }, [externalTerminalCwd]);

  return {
    sessionId,
    session,
    ptyId,
    reentryResult,
    reentering,
    checking,
    missing: unresolved && !checking,
    terminalFinished,
    focusTerminal,
    agentBusy: Boolean(
      session && (session.status === "active" || hasActionableWait(session)),
    ),
    resumeCommand:
      reentryResult?.command?.display ??
      (session ? commandDisplay(session) : null),
    externalTerminalCwd,
    continueInTerminal,
    closeTerminal,
    openExternalTerminal,
  };
}

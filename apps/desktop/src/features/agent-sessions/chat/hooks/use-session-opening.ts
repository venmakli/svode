import { useCallback, useEffect, useRef, useState } from "react";
import { requestAgentSessionCatalogFastRefresh } from "../../hooks/use-agent-session-catalog";
import {
  agentSettingRefusal,
  openSessionInChat,
  type AgentExternalLivenessDto,
  type AgentLaunchUnavailableDto,
  type AgentSessionKeyDto,
  type AgentSessionOpeningDto,
  type AgentSessionValuesDto,
  type AgentSettingRefusalDto,
  type AgentSettingValueDto,
} from "../api/chat";
import { errorMessage } from "./use-session-composer";

export type SessionOpening =
  | { state: "opening" }
  | {
      state: "opened";
      session: AgentSessionKeyDto;
      liveness: AgentExternalLivenessDto;
      /**
       * What the session's own last turn gives attaching it where the user
       * chose no value (DF-171 R2); a value it refused is left out.
       */
      sessionValues: AgentSessionValuesDto | null;
      /** Grows when the session is attached again; the chat subscribes anew. */
      epoch: number;
    }
  | { state: "confirmation_required"; turnOpen: boolean }
  | { state: "external_active" }
  | { state: "terminal_active" }
  | { state: "unsupported" }
  | { state: "unavailable"; reason: AgentLaunchUnavailableDto }
  | { state: "auth_required"; message: string }
  | { state: "failed"; message: string };

/**
 * What an opening shows while it runs: the loading state, a busy "Load
 * history", or the snapshot read before, kept until the new reading.
 */
type OpenMode = "read" | "load_history" | "refresh";

/** Why continuing a read session did not attach it; the draft stays. */
export type ContinueRefusal =
  | Extract<AgentSessionOpeningDto, { outcome: "unavailable" | "auth_required" }>
  /** A value chosen before attaching did not apply (DF-171 R1). */
  | { outcome: "setting_refused"; refusal: AgentSettingRefusalDto }
  | { outcome: "failed"; message: string };

/** What attaching a read session before its first send did. */
export type AttachOutcome =
  | { attached: true }
  | { attached: false; refusedSetting: AgentSettingRefusalDto | null };

/**
 * Opening an existing session in the chat (Stage 10 `04`, opening and
 * continuing): the history without a prompt, "Load history" when attaching
 * needs the user's confirmation, reading a snapshot again while another
 * process writes to the session, and attaching a read session before its
 * first send.
 */
export function useSessionOpening(projectPath: string | null, sessionId: string) {
  const [opening, setOpening] = useState<SessionOpening>({ state: "opening" });
  const [attaching, setAttaching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [continueRefusal, setContinueRefusal] = useState<ContinueRefusal | null>(null);
  const generation = useRef(0);

  const open = useCallback(
    async (mode: OpenMode) => {
      if (!projectPath) return;
      const own = ++generation.current;
      const attach = mode === "load_history";
      if (mode === "load_history") setAttaching(true);
      else if (mode === "refresh") setRefreshing(true);
      else setOpening({ state: "opening" });
      try {
        const outcome = await openSessionInChat(projectPath, sessionId, attach);
        if (own !== generation.current) return;
        setOpening((current) => opened(current, outcome));
        if (attach && outcome.outcome === "opened") {
          requestAgentSessionCatalogFastRefresh();
        }
      } catch (error) {
        if (own === generation.current) {
          setOpening({ state: "failed", message: errorMessage(error) });
        }
      } finally {
        if (own === generation.current) {
          setAttaching(false);
          setRefreshing(false);
        }
      }
    },
    [projectPath, sessionId],
  );

  useEffect(() => {
    void open("read");
    return () => {
      generation.current += 1;
    };
  }, [open]);

  /**
   * Attaches a read session before its first send with the values chosen
   * for it, the user's confirmation of this attempt; the chat may send once
   * it is attached.
   */
  const attach = useCallback(
    async (settings: AgentSettingValueDto[]): Promise<AttachOutcome> => {
      const notAttached = { attached: false, refusedSetting: null } as const;
      if (!projectPath) return notAttached;
      setContinueRefusal(null);
      setAttaching(true);
      let outcome: AgentSessionOpeningDto;
      try {
        outcome = await openSessionInChat(projectPath, sessionId, true, settings);
      } catch (error) {
        const refusal = agentSettingRefusal(error);
        if (refusal) {
          setOpening((current) => withoutRefused(current, refusal));
          setContinueRefusal({ outcome: "setting_refused", refusal });
          return { attached: false, refusedSetting: refusal };
        }
        setContinueRefusal({ outcome: "failed", message: errorMessage(error) });
        return notAttached;
      } finally {
        setAttaching(false);
      }
      switch (outcome.outcome) {
        case "opened":
        case "external_active":
        case "terminal_active":
          setOpening((current) => opened(current, outcome));
          if (outcome.outcome === "opened") {
            requestAgentSessionCatalogFastRefresh();
            return { attached: true };
          }
          return notAttached;
        case "unavailable":
        case "auth_required":
          setContinueRefusal(outcome);
          return notAttached;
        case "confirmation_required":
        case "unsupported":
          setOpening((current) => opened(current, outcome));
          return notAttached;
      }
    },
    [projectPath, sessionId],
  );

  return {
    opening,
    attaching,
    continueRefusal,
    /** "Load history": attach the session, confirming this attempt. */
    loadHistory: () => void open("load_history"),
    retry: () => void open("read"),
    refreshing,
    /** Reads the history again; the snapshot stays shown until then. */
    refresh: () => void open("refresh"),
    attach,
  };
}

/** The next state after an opening outcome. */
function opened(current: SessionOpening, outcome: AgentSessionOpeningDto): SessionOpening {
  const epoch = current.state === "opened" ? current.epoch : 0;
  switch (outcome.outcome) {
    case "opened":
      return {
        state: "opened",
        session: outcome.session,
        liveness: outcome.liveness,
        sessionValues: outcome.sessionValues ?? null,
        epoch: epoch + 1,
      };
    case "external_active":
      // A read history stays; only continuing it is refused.
      return current.state === "opened"
        ? { ...current, liveness: "external_active" }
        : { state: "external_active" };
    case "confirmation_required":
      return { state: "confirmation_required", turnOpen: outcome.turnOpen };
    case "unavailable":
      return { state: "unavailable", reason: outcome.reason };
    case "auth_required":
      return { state: "auth_required", message: outcome.message };
    default:
      return { state: outcome.outcome };
  }
}

/** The opening without a session value attaching it refused. */
function withoutRefused(
  current: SessionOpening,
  refused: AgentSettingRefusalDto,
): SessionOpening {
  if (current.state !== "opened" || !current.sessionValues) return current;
  return {
    ...current,
    sessionValues: {
      ...current.sessionValues,
      values: current.sessionValues.values.filter(
        (value) =>
          value.setting !== refused.setting || value.value !== refused.value,
      ),
    },
  };
}

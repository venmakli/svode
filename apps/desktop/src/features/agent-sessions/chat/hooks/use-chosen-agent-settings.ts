import { useCallback, useMemo } from "react";
import type { AgentCheckDto } from "../api/chat";
import type { ChatAgent } from "../model/agents";
import { declaredSettings, withKeptValue } from "../model/declared-settings";
import type { SettingValue } from "../model/session-controls";
import { useLastAgentDeclarations } from "./use-agent-declarations";
import { useDraftAgent, type DraftAgentState } from "./use-draft-agent";
import { useDraftSettings, type UpdateKeptValues } from "./use-draft-settings";
import { useSessionActivity } from "./use-session-activity";

/** A readiness of an agent without its connection: the chat's offer of it. */
const UNCHECKED_READY: AgentCheckDto = {
  state: "ready",
  agent: {
    name: null,
    version: null,
    capabilities: {
      loadSession: false,
      listSessions: false,
      resumeSession: false,
      closeSession: false,
    },
  },
};

function offerReadiness(offer: ChatAgent["offer"] | null): DraftAgentState {
  switch (offer?.state) {
    case "sign_in_required":
      return { state: "checked", check: { state: "auth_required", message: "" } };
    case "unavailable":
      return {
        state: "checked",
        check: { state: "unavailable", reason: offer.reason },
      };
    default:
      return { state: "checked", check: UNCHECKED_READY };
  }
}

/**
 * The settings of an agent chosen before a session starts, with the values
 * a host keeps for it (Stage 11 `03`, announcements without a started
 * session): a new session draft, the device's default agent, an Actor
 * binding. In `cwd` the agent's draft session opens where its recorded
 * evidence allows it, and a change goes to that session before the host
 * keeps the value the agent confirmed. A draft session that takes values
 * only with the first send, no draft session, or no `cwd` at all show the
 * agent's last declarations, and the host keeps a chosen value at once.
 */
export function useChosenAgentSettings({
  agent,
  cwd,
  offer,
  values,
  updateValues,
}: {
  agent: string | null;
  /** Where the draft session opens; null opens none and starts no agent. */
  cwd: string | null;
  /**
   * How the chat offers the agent: its own sign-in check, and without `cwd`
   * its readiness.
   */
  offer: ChatAgent["offer"] | null;
  /** The values the host keeps for `agent`. */
  values: SettingValue[];
  updateValues: UpdateKeptValues;
}) {
  const connected = cwd !== null;
  const {
    readiness: started,
    retry,
    hold,
    session: draftSession,
    keepsValuesUntilSend,
  } = useDraftAgent(connected ? agent : null, cwd ?? "");
  const { snapshot } = useSessionActivity(draftSession);
  // Values change in the draft session itself only where it takes them.
  const liveSession = keepsValuesUntilSend ? null : draftSession;
  const settings = useDraftSettings(
    agent,
    liveSession,
    snapshot,
    values,
    updateValues,
  );
  // The agent's ACP connection starts without sign-in; its own sign-in
  // check tells that the first send would be refused.
  const signInRequired = offer?.state === "sign_in_required";
  const readiness = useMemo<DraftAgentState>(() => {
    if (!agent) return { state: "idle" };
    if (!connected) return offerReadiness(offer);
    return signInRequired &&
      started.state === "checked" &&
      started.check.state === "ready"
      ? { state: "checked", check: { state: "auth_required", message: "" } }
      : started;
  }, [agent, connected, offer, signInRequired, started]);
  const ready =
    readiness.state === "checked" && readiness.check.state === "ready";
  // Without a live draft session the host keeps the chosen values itself.
  const keepsValues = ready && !liveSession;
  // Without a connection the last declarations still name the kept values.
  const declarations = useLastAgentDeclarations(
    agent,
    keepsValues || (!connected && Boolean(agent)),
  );
  const declared = useMemo(() => {
    if (!keepsValues && connected) return null;
    // A draft session's own declaration comes first once it arrives.
    if (draftSession && !snapshot) {
      return { settings: null, recorded: false, withoutVariants: [] };
    }
    return declaredSettings({
      session: snapshot?.settings ?? null,
      declarations: declarations ?? [],
      values,
    });
  }, [connected, declarations, draftSession, keepsValues, snapshot, values]);
  const shownSettings = declared
    ? declared.settings
    : liveSession && snapshot
      ? snapshot.settings
      : null;
  const keepValue = useCallback(
    (value: SettingValue) =>
      updateValues((latest) =>
        withKeptValue(latest, value, shownSettings ?? []),
      ),
    [shownSettings, updateValues],
  );

  return {
    readiness,
    retry,
    /** The hold of the agent's connection while it is open. */
    hold,
    /** The draft session the agent opened without a prompt, if any. */
    draftSession,
    /** The draft session's settings, commands and usage once it exists. */
    snapshot: draftSession ? snapshot : null,
    /** The settings shown, with the kept values. */
    settings: shownSettings,
    /** The host keeps a chosen value without the agent. */
    keepsValues,
    /** The settings come from the agent's last session on this device. */
    recorded: declared?.recorded ?? false,
    /** Settings whose options show after a session with the chosen model. */
    withoutVariants: declared?.withoutVariants ?? [],
    /** Nothing declared yet: the agent's settings show after the first send. */
    settingsAfterSend:
      keepsValues &&
      !draftSession &&
      declarations !== null &&
      shownSettings === null,
    changeSetting: keepsValues
      ? async (value: SettingValue) => keepValue(value)
      : settings.changeSetting,
    /** The setting whose change waits for the agent. */
    changing: settings.changing,
    refusal: settings.refusal,
    refuse: settings.refuse,
    dismissRefusal: settings.dismissRefusal,
  };
}

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  useChosenAgentSettings,
  type AgentReadiness,
  type AgentSetting,
  type AgentSettingValue,
  type AgentSettingsChoice,
  type ChatAgents,
  type UpdateAgentSettingValues,
} from "@/features/agent-sessions/agent-settings-popover";
import * as m from "@/paraglide/messages.js";
import { getNativeErrorMessage } from "@/platform/native/errors";

import { signInBindingAgent } from "../api/agent-actors-api";
import {
  bindingAgent,
  withBindingAgent,
  withoutBindingSettings,
  withParticipantBinding,
} from "../model/agent-actor-draft";
import type {
  AgentActorAgentOption,
  AgentActorDraft,
} from "../model/agent-actor-types";

const NO_VALUES: readonly AgentSettingValue[] = [];

/** An agent this version cannot bind, as a custom agent of a V1 catalog. */
const UNAVAILABLE: AgentReadiness = {
  state: "checked",
  check: { state: "unavailable", reason: { code: "not_supported" } },
};

export type AgentActorBindingEditor = ReturnType<typeof useAgentActorBinding>;

/**
 * The binding of an Actor's draft in the agent settings popover (Stage 11
 * `03`, host "Actor binding"): the bindable agents as tabs and the
 * participant's agent beside them, the agent's declared settings with the
 * values the draft keeps and its device mode as the last row. While the
 * form is open (`cwd`, the Space of the Actor's catalog) the agent's draft
 * session gives the settings; without it the agent's last declarations do.
 * Values are kept only from declared options; a kept value the agent no
 * longer declares shows with a note until another is chosen, and one of
 * the setting the agent declares in category `mode` is never written to
 * the catalog.
 */
export function useAgentActorBinding({
  agents,
  cwd,
  draft,
  editable,
  offers,
  onChange,
  onRecheck,
}: {
  /** The bindable built-in agents of this version. */
  agents: readonly AgentActorAgentOption[];
  /** Where the agent's draft session opens; null opens none. */
  cwd: string | null;
  draft: AgentActorDraft;
  /** The binding can change; otherwise it only shows. */
  editable: boolean;
  /** How the chat offers the agents; null while they are read. */
  offers: ChatAgents | null;
  onChange(draft: AgentActorDraft): void;
  /** Reads the agents' offers again, as after a sign-in. */
  onRecheck(): void;
}) {
  const agent = bindingAgent(draft.binding);
  const participant = draft.binding?.kind === "participant";
  const known = agent !== null && agents.some((option) => option.id === agent);
  const portable =
    draft.binding?.kind === "agent" ? draft.binding.settings : NO_VALUES;
  const mode =
    agent !== null && draft.mode?.agent === agent ? draft.mode : null;
  // The setting the agent declares in category `mode`, once it is known.
  const [learned, setLearned] = useState<{
    agent: string;
    setting: string | null;
  } | null>(null);
  const modeSettingId = learned?.agent === agent ? learned.setting : null;
  const values = useMemo<AgentSettingValue[]>(() => {
    const deviceSetting = mode?.setting ?? null;
    return [
      ...portable.filter(
        (value) =>
          value.setting !== modeSettingId && value.setting !== deviceSetting,
      ),
      ...(mode ? [{ setting: mode.setting, value: mode.value }] : []),
    ];
  }, [mode, modeSettingId, portable]);

  // A change applies to the latest draft, as one confirmed by the agent's
  // draft session after the user went on.
  const latest = useRef({ agent, draft, modeSettingId, onChange, values });
  useLayoutEffect(() => {
    latest.current = { agent, draft, modeSettingId, onChange, values };
  });
  const updateValues = useCallback<UpdateAgentSettingValues>((change) => {
    const current = latest.current;
    // A change for an agent the binding no longer has.
    if (!current.agent || bindingAgent(current.draft.binding) !== current.agent)
      return;
    const next = change(current.values);
    const modeKey =
      current.modeSettingId ??
      (current.draft.mode?.agent === current.agent
        ? current.draft.mode.setting
        : null);
    const modeValue =
      modeKey === null
        ? undefined
        : next.find((value) => value.setting === modeKey);
    current.onChange({
      ...current.draft,
      binding: {
        agent: current.agent,
        kind: "agent",
        settings: next.filter((value) => value.setting !== modeKey),
      },
      mode:
        modeKey !== null && modeValue
          ? { agent: current.agent, setting: modeKey, value: modeValue.value }
          : null,
    });
  }, []);

  const offer =
    offers?.agents.find((candidate) => candidate.agent === agent)?.offer ??
    null;
  const chosen = useChosenAgentSettings({
    agent: known ? agent : null,
    cwd,
    offer,
    values,
    updateValues,
    keepUndeclared: true,
  });
  const settings = known ? chosen.settings : null;
  const modeSetting =
    settings?.find((setting) => setting.category === "mode") ?? null;
  if (
    agent !== null &&
    settings !== null &&
    (learned?.agent !== agent || learned.setting !== (modeSetting?.id ?? null))
  ) {
    setLearned({ agent, setting: modeSetting?.id ?? null });
  }

  // The entry keeps naming the values while the agent's settings load.
  const [named, setNamed] = useState<{
    agent: string;
    settings: AgentSetting[];
  } | null>(null);
  if (agent && settings && named?.settings !== settings) {
    setNamed({ agent, settings });
  }

  const [signIn, setSignIn] = useState<{
    agent: string;
    ptyId: string;
  } | null>(null);
  const startSignIn =
    known && agent
      ? () => {
          void signInBindingAgent(agent)
            .then((ptyId) => setSignIn({ agent, ptyId }))
            .catch((error: unknown) => {
              toast.error(m.sessions_chat_sign_in_failed(), {
                description: getNativeErrorMessage(error),
              });
            });
        }
      : null;
  const recheck = () => {
    onRecheck();
    chosen.retry();
  };

  const readiness: AgentReadiness =
    agent !== null && !known ? UNAVAILABLE : chosen.readiness;
  const waiting =
    readiness.state === "idle" || readiness.state === "connecting";
  // A value of the mode's setting in the catalog is not offered here: the
  // mode belongs to this device.
  const portableModeValues =
    settings && modeSetting
      ? portable.filter((value) => value.setting === modeSetting.id)
      : NO_VALUES;
  const choice = (
    onOpenSettings: () => void,
  ): Omit<AgentSettingsChoice, "onChoose"> => ({
    agents: agents
      .filter((option) => editable || option.id === agent)
      .map((option) => ({ agent: option.id, name: option.label })),
    readiness,
    recovery: {
      onSignIn: startSignIn,
      onOpenSettings,
      onRetry: recheck,
    },
    settingsAfterSend: known && chosen.settingsAfterSend,
    recorded: known && chosen.recorded,
    withoutVariants: known ? chosen.withoutVariants : [],
    staleValues: [...(known ? chosen.staleValues : []), ...portableModeValues],
    // Without the agent's settings the values show as they are.
    keptValues:
      agent !== null && settings === null && !waiting
        ? [
            ...values,
            ...portable.filter(
              (value) =>
                value.setting === modeSettingId &&
                value.setting !== mode?.setting,
            ),
          ]
        : undefined,
  });

  return {
    /** The binding's agent; null for the participant's agent or none. */
    agent,
    /** This version can bind the agent. */
    known,
    participant,
    editable,
    choice,
    chooseAgent: (next: string) => {
      if (editable) onChange(withBindingAgent(draft, next));
    },
    chooseParticipant: () => {
      if (editable) onChange(withParticipantBinding(draft));
    },
    settings,
    canChange:
      editable &&
      known &&
      (chosen.keepsValues || chosen.snapshot?.writer === "acp"),
    changing: chosen.changing,
    changeSetting: (value: AgentSettingValue) =>
      void chosen.changeSetting(value),
    /** The settings the entry names. */
    summarySettings:
      settings ?? (named && named.agent === agent ? named.settings : null),
    /** The agent's setting of category `mode`, once it is known. */
    modeSetting,
    /** The draft as the catalog takes it: no value of the mode's setting. */
    forSave: (next: AgentActorDraft) =>
      modeSettingId ? withoutBindingSettings(next, [modeSettingId]) : next,
    /** The sign-in terminal of the binding's agent while it is open. */
    signIn,
    recheck,
    endSignIn: () => {
      setSignIn(null);
      recheck();
    },
  };
}

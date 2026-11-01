import {
  declaredSettings,
  type AgentDeclaration,
  type AgentSetting,
  type ChatAgent,
  type DefaultAgent,
} from "@/features/agent-sessions/agent-settings-popover";

import type { AgentActorRow } from "./agent-actor-types";

/**
 * The readiness of an Agent on this device (Stage 11 `03`, the properties
 * of the Agents collection): of the binding's agent, or of the default
 * agent for the participant's agent.
 */
export type AgentActorReadiness =
  | "ready"
  | "sign_in_required"
  | "not_installed"
  /** The agent cannot be bound in this version, or cannot start for another reason. */
  | "unavailable"
  | "default_agent_missing"
  /** A kept value the agent no longer declares. */
  | "value_not_declared";

/** The device mode of an Agent in the agent's own words. */
export type AgentActorModeFact =
  | { kind: "value"; name: string }
  /** The agent declares a mode, and none is chosen on this device. */
  | { kind: "agent_default" };

export interface AgentActorFacts {
  /**
   * This version can bind the agent; an agent it cannot, as a custom agent
   * of a V1 catalog, is named by its id as it is.
   */
  bindable: boolean;
  /** The name of the model value of the binding; null without one. */
  model: string | null;
  /** Null for the participant's agent and an agent without modes. */
  mode: AgentActorModeFact | null;
  /** Null while it is not known yet. */
  readiness: AgentActorReadiness | null;
}

export interface AgentActorFactsSources {
  /** The bindable agents of this version. */
  known: ReadonlySet<string>;
  /** How the chat offers each agent; null while they are read. */
  offers: readonly ChatAgent[] | null;
  /** The device's default agent; undefined while it is read. */
  defaultAgent: DefaultAgent | null | undefined;
  /** What each agent declared last on this device, by agent id. */
  declarations: ReadonlyMap<string, readonly AgentDeclaration[]>;
}

/** Unavailable reasons that mean the agent is not installed on this device. */
const NOT_INSTALLED = new Set([
  "executable_missing",
  "adapter_not_installed",
  "node_missing",
]);

export function agentActorFacts(
  row: AgentActorRow,
  sources: AgentActorFactsSources,
): AgentActorFacts {
  const binding = row.binding;
  if (binding.kind === "participant") {
    const defaultAgent = sources.defaultAgent;
    return {
      bindable: true,
      model: null,
      mode: null,
      readiness:
        defaultAgent === undefined
          ? null
          : defaultAgent === null
            ? "default_agent_missing"
            : offerReadiness(defaultAgent.agent, sources.offers),
    };
  }
  const agent = binding.agent;
  const declarations = sources.declarations.get(agent) ?? null;
  const mode = row.mode?.agent === agent ? row.mode : null;
  const values = [
    ...binding.settings,
    ...(mode ? [{ setting: mode.setting, value: mode.value }] : []),
  ];
  const declared = declarations
    ? declaredSettings({
        session: null,
        declarations: [...declarations],
        values,
      })
    : null;
  const settings = declared?.settings ?? null;
  const modelSetting = settings?.find(
    (setting) => setting.category === "model",
  );
  const modelValue = modelSetting
    ? binding.settings.find((value) => value.setting === modelSetting.id)
    : (binding.settings.find((value) => value.setting === "model") ?? null);
  const modeSetting = settings?.find((setting) => setting.category === "mode");
  // A value of the mode's setting in the catalog, as a hand-edited one, is
  // not applied either (Stage 11 `03`, the binding and catalog V2).
  const stale =
    (settings !== null &&
      values.some((value) =>
        isUndeclared(value, settings, declared?.withoutVariants ?? []),
      )) ||
    (modeSetting !== undefined &&
      binding.settings.some((value) => value.setting === modeSetting.id));
  const bindable = sources.known.has(agent);
  const readiness = bindable
    ? offerReadiness(agent, sources.offers)
    : "unavailable";
  return {
    bindable,
    model: modelValue ? optionName(modelSetting, modelValue.value) : null,
    mode: mode
      ? { kind: "value", name: optionName(modeSetting, mode.value) }
      : settings !== null && !modeSetting
        ? null
        : { kind: "agent_default" },
    readiness:
      readiness === "ready" && stale ? "value_not_declared" : readiness,
  };
}

function offerReadiness(
  agent: string,
  offers: readonly ChatAgent[] | null,
): AgentActorReadiness | null {
  if (!offers) return null;
  const offer = offers.find((candidate) => candidate.agent === agent)?.offer;
  switch (offer?.state) {
    case "available":
      return "ready";
    case "sign_in_required":
      return "sign_in_required";
    case "unavailable":
      return NOT_INSTALLED.has(offer.reason.code)
        ? "not_installed"
        : "unavailable";
    default:
      return "unavailable";
  }
}

function isUndeclared(
  value: { setting: string; value: string },
  settings: readonly AgentSetting[],
  withoutVariants: readonly string[],
): boolean {
  if (withoutVariants.includes(value.setting)) return false;
  return !settings.some(
    (setting) =>
      setting.id === value.setting &&
      setting.options.some((option) => option.value === value.value),
  );
}

/** The agent's name of a value, or the value itself where it names none. */
function optionName(setting: AgentSetting | undefined, value: string): string {
  return (
    setting?.options.find((option) => option.value === value)?.name ?? value
  );
}

import type { ColorName } from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import { AGENT_ICONS, type AgentIconAsset } from "./icons";

export interface AgentAdapterIdentity {
  id: string;
  displayName: string;
}

export interface AgentOption {
  name: string;
  color: ColorName;
}

/** The only place that colors agents; labels come from the adapter registry. */
const AGENT_COLORS: Readonly<Record<string, ColorName>> = {
  codex: "blue",
  "claude-code": "orange",
};

const FALLBACK_COLOR: ColorName = "neutral";

/**
 * How an agent is drawn: its brand icon, or the first letter of its name
 * for a custom agent and an unknown id.
 */
export type AgentIcon =
  | ({ kind: "brand" } & AgentIconAsset)
  | { kind: "letter"; letter: string };

/** Agent names, colors and icons by adapter id, for every place that shows an agent. */
export interface AgentAdapterDictionary {
  /** The registry labels have been read, or reading them failed. */
  ready: boolean;
  label(adapterId: string): string;
  color(adapterId: string): ColorName;
  icon(adapterId: string): AgentIcon;
  /**
   * Select options of every registered agent, plus the neutral fallback when
   * one of `adapterIds` is not registered.
   */
  options(adapterIds?: Iterable<string>): AgentOption[];
}

export function createAgentAdapterDictionary(
  identities: readonly AgentAdapterIdentity[],
  ready = true,
): AgentAdapterDictionary {
  const labels = new Map(
    identities.map((identity) => [identity.id, identity.displayName]),
  );
  const label = (adapterId: string) =>
    labels.get(adapterId) ?? m.agent_adapter_unknown();
  const color = (adapterId: string) =>
    (labels.has(adapterId) && AGENT_COLORS[adapterId]) || FALLBACK_COLOR;

  const icon = (adapterId: string): AgentIcon => {
    const asset = AGENT_ICONS[adapterId];
    if (asset) return { kind: "brand", ...asset };
    const letter = Array.from(label(adapterId).trim())[0] ?? "?";
    return { kind: "letter", letter: letter.toLocaleUpperCase() };
  };

  return {
    ready,
    label,
    color,
    icon,
    options(adapterIds = []) {
      const options: AgentOption[] = identities.map((identity) => ({
        name: identity.displayName,
        color: color(identity.id),
      }));
      for (const adapterId of adapterIds) {
        if (labels.has(adapterId)) continue;
        options.push({ name: label(adapterId), color: FALLBACK_COLOR });
        break;
      }
      return options;
    },
  };
}
